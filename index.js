// 1. CONFIGURAÇÃO INICIAL
// =================================
require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 9002;

// 2. ESTADOS E CONFIGURAÇÕES DE REFINAMENTO
// =================================
const STATES = Object.freeze({
    INICIO_MENU: 'inicio_menu',
    AGUARDANDO_OPCAO_MENU: 'aguardando_opcao_menu',
    AGUARDANDO_OPCAO_CONSULTOR: 'aguardando_opcao_consultor',
    INICIANDO_CAPTURA: 'iniciando_captura',
    AGUARDANDO_NOME: 'aguardando_nome',
    AGUARDANDO_EMAIL: 'aguardando_email',
    LEAD_CAPTURADO: 'lead_capturado',
    LEAD_PARCIAL_CAPTURADO: 'lead_parcial_capturado',
    ATENDIMENTO_HUMANO: 'atendimento_humano'
});

const DOMINIOS_EMAIL_VALIDOS = [
    'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br',
    'icloud.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'gmail.com.br'
];

const KEYWORDS_CAPTURA = ['firminopolis', 'firminópolis', 'graciosa', 'novo lar', 'casa', 'lote', 'financiamento'];
const KEYWORDS_ENCERRAMENTO = ['encerrar', 'parar', 'finalizar', 'cancelar', 'sair'];
const KEYWORDS_REINICIO = ['menu', 'reiniciar', 'reinicio', 'reset', 'restart', 'voltar'];

const TEMPO_LEMBRETE = 10 * 60 * 1000;
const TEMPO_ENVIO_PARCIAL = 20 * 60 * 1000;

// 3. CONFIGURAÇÃO DO CLIENTE DO WHATSAPP
// =================================
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "habiticon-gyn-bot" }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--no-zygote', '--disable-dev-shm-usage']
    }
});

// 4. BANCO DE DADOS EM MEMÓRIA E FUNÇÕES AUXILIARES
// =================================
const chatStates = new Map();

function validarEmail(email) {
    if (!email || !email.includes('@')) return false;
    const dominio = email.split('@')[1];
    return DOMINIOS_EMAIL_VALIDOS.includes(dominio.toLowerCase());
}

// 5. FUNÇÕES PRINCIPAIS
// =================================
async function enviarLeadParaMake(dadosDoLead) {
    const webhookUrl = process.env.MAKE_WEBHOOK_URL;
    if (!webhookUrl) return false;
    try {
        const now = new Date();
        const fusoHorario = 'America/Sao_Paulo';
        const dataFormatada = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: fusoHorario }).format(now);
        const horarioFormatado = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: fusoHorario }).format(now);

        const dadosCompletos = {
            "Nome": dadosDoLead.nome || "Não informado", "Telefone": dadosDoLead.telefone, "E-mail": dadosDoLead.email || "Não informado",
            "URL da página": "WhatsApp Bot", "Data": dataFormatada, "Horário": horarioFormatado, "Status": "Novo"
        };
        await axios.post(webhookUrl, dadosCompletos);
        console.log("[MAKE] Lead enviado com sucesso!", dadosCompletos);
        return true;
    } catch (error) {
        console.error(`[MAKE] Erro ao enviar lead para o webhook: ${error.message}`);
        return false;
    }
}

// 6. EVENTOS DO CLIENTE DO WHATSAPP
// =================================
client.on('qr', qr => { qrcode.generate(qr, { small: true }); });
client.on('ready', () => { console.log('[LOG DO BOT] >>> CLIENTE PRONTO E CONECTADO! <<<'); });

client.on('message_create', async msg => {
    if (msg.isGroup || msg.isStatus || msg.fromMe) return;

    const chatId = msg.from;
    let textoMensagem = msg.body.trim();
    const textoNormalizado = textoMensagem.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    let currentState = chatStates.get(chatId) || { state: STATES.INICIO_MENU, data: {}, lastInteraction: Date.now(), reminderSent: false };
    currentState.lastInteraction = Date.now();
    currentState.reminderSent = false;

    console.log(`[MENSAGEM] Recebida de ${chatId}. Estado: ${currentState.state}. Msg: "${textoMensagem}"`);

    if (KEYWORDS_REINICIO.includes(textoNormalizado)) {
        currentState.state = STATES.INICIO_MENU;
        console.log(`[ESTADO] Conversa com ${chatId} reiniciada pelo usuário.`);
    }

    const estadosDeCaptura = [STATES.INICIANDO_CAPTURA, STATES.AGUARDANDO_NOME, STATES.AGUARDANDO_EMAIL];
    if (KEYWORDS_ENCERRAMENTO.includes(textoNormalizado)) {
        if (estadosDeCaptura.includes(currentState.state)) {
            currentState.data.telefone = chatId.replace('@c.us', '');
            await enviarLeadParaMake(currentState.data);
            await client.sendMessage(chatId, "Entendido. Suas informações foram salvas e um consultor poderá entrar em contato. Atendimento encerrado. 😊");
        } else {
            await client.sendMessage(chatId, "Atendimento encerrado. Se precisar de algo mais, basta nos chamar!");
        }
        chatStates.delete(chatId);
        return;
    }
    
    const isPrimeiraConversa = currentState.state === STATES.INICIO_MENU;
    const contemKeyword = KEYWORDS_CAPTURA.some(keyword => textoNormalizado.includes(keyword));
    if (isPrimeiraConversa && contemKeyword && !msg.hasMedia) {
        currentState.state = STATES.INICIANDO_CAPTURA;
    }

    const estadosDeMenu = [STATES.AGUARDANDO_OPCAO_MENU, STATES.AGUARDANDO_OPCAO_CONSULTOR];
    if (msg.hasMedia && estadosDeMenu.includes(currentState.state)) {
        await client.sendMessage(chatId, "Desculpe, neste momento não consigo processar áudios ou ficheiros.\n\nPor favor, escolha uma das opções *digitando o número* correspondente.");
        return;
    }

    switch (currentState.state) {
        case STATES.INICIO_MENU:
            if (msg.hasMedia && !isPrimeiraConversa) {}
            else {
                if (msg.hasMedia) {
                    await client.sendMessage(chatId, "Olá! Recebi o seu ficheiro. Para que eu possa ajudar, vou apresentar as minhas opções de atendimento. 😊");
                } else {
                    const logoPath = './logo.png';
                    if (fs.existsSync(logoPath)) {
                        await client.sendMessage(chatId, MessageMedia.fromFilePath(logoPath), { caption: ' ' });
                    }
                    await client.sendMessage(chatId, "🏠 Olá! Sou a assistente virtual da *Habiticon*.\n\nComo posso ajudar você hoje?");
                }
                await client.sendMessage(chatId, "Por favor, escolha uma das opções abaixo:\n\n*1️⃣ Lançamento Residencial Graciosa (Firminópolis-GO)*\n*2️⃣ Falar com um Consultor*\n*3️⃣ Sobre a Habiticon*\n*4️⃣ Já sou Cliente*\n*5️⃣ Encerrar Atendimento*\n\n_A qualquer momento, digite *menu* para voltar a estas opções._");
                currentState.state = STATES.AGUARDANDO_OPCAO_MENU;
            }
            break;

        case STATES.AGUARDANDO_OPCAO_MENU:
            switch (textoMensagem) {
                case '1':
                    currentState.state = STATES.INICIANDO_CAPTURA;
                    await client.sendMessage(chatId, "Excelente escolha! Vamos iniciar o seu cadastro para o lançamento do *Residencial Graciosa*.");
                    break;
                case '2':
                    await client.sendMessage(chatId, "Entendido. Para direcionar melhor o seu atendimento, sobre qual assunto você gostaria de falar?\n\n*1️⃣ Sobre o lançamento em Firminópolis*\n*2️⃣ Outro assunto*\n\n_Digite *menu* para voltar ao início._");
                    currentState.state = STATES.AGUARDANDO_OPCAO_CONSULTOR;
                    break;
                case '3':
                    await client.sendMessage(chatId, "A *Habiticon* nasceu com o propósito de transformar o sonho da casa própria em realidade, oferecendo projetos modernos, de qualidade e com condições facilitadas. Estamos muito felizes por começar a nossa história em Firminópolis com o Residencial Graciosa! 🚀");
                    await client.sendMessage(chatId, "Para voltar ao menu, digite *menu*.");
                    break;
                case '4':
                    await client.sendMessage(chatId, "Que bom ter você de volta! Para agilizar, pode me adiantar do que precisa (enviando texto, áudio ou documentos).\n\nUm consultor irá assumir a conversa assim que possível para dar continuidade ao seu atendimento. 👍");
                    currentState.state = STATES.ATENDIMENTO_HUMANO;
                    break;
                case '5':
                    await client.sendMessage(chatId, "Atendimento encerrado. Obrigado pelo seu contato!");
                    chatStates.delete(chatId);
                    return;
                default:
                    await client.sendMessage(chatId, "😕 Opção não reconhecida.\n\nPor favor, digite apenas o número da opção desejada. Se preferir, digite *menu* para ver as opções novamente.");
                    break;
            }
            if (currentState.state !== STATES.INICIANDO_CAPTURA) break;

        case STATES.AGUARDANDO_OPCAO_CONSULTOR:
            switch (textoMensagem) {
                case '1':
                    currentState.state = STATES.INICIANDO_CAPTURA;
                    await client.sendMessage(chatId, "Ótimo! Para adiantar o seu atendimento sobre o lançamento, vou recolher alguns dados.");
                    break;
                case '2':
                    await client.sendMessage(chatId, "Certo! Estou transferindo a sua conversa para um de nossos consultores. Em breve ele(a) irá te atender por aqui. 👨‍💼👩‍💼");
                    currentState.state = STATES.ATENDIMENTO_HUMANO;
                    break;
                default:
                    await client.sendMessage(chatId, "😕 Opção não reconhecida.\n\nPor favor, digite apenas o número da opção desejada. Se preferir, digite *menu* para ver as opções novamente.");
                    break;
            }
            if (currentState.state !== STATES.INICIANDO_CAPTURA) break;

        case STATES.INICIANDO_CAPTURA:
            await client.sendMessage(chatId, "Para começar, por favor, me diga seu *nome completo*. 👇");
            currentState.state = STATES.AGUARDANDO_NOME;
            break;
            
        case STATES.AGUARDANDO_NOME:
            currentState.data.nome = textoMensagem;
            const nomeCliente = currentState.data.nome.split(' ')[0];
            await client.sendMessage(chatId, `Obrigado, *${nomeCliente}*! ✨\n\nAgora, só preciso do seu *melhor e-mail*.\n\nCom ele, poderemos te enviar:\n• Informações exclusivas\n• Uma pré-simulação do seu financiamento`);
            currentState.state = STATES.AGUARDANDO_EMAIL;
            break;

        case STATES.AGUARDANDO_EMAIL:
    if (validarEmail(textoMensagem)) {
        currentState.data.email = textoMensagem;
        currentState.data.telefone = chatId.replace('@c.us', '');
        
        // Mantém o envio para a planilha
        const leadEnviado = await enviarLeadParaMake(currentState.data);

        // ### INÍCIO DA ADIÇÃO ###
        // A linha abaixo presume que o painel já injetou o 'require' no topo do ficheiro.
        // Ela só executa se o lead foi enviado com sucesso para o Make.com.
        if (leadEnviado && typeof sendNotification === 'function') {
            // Supondo que você cadastrou a notificação no painel com o nome "Novos Leads"
            const nomeDoCanal = 'Novos Leads'; 
            const mensagemNotificacao = `🎉 Novo lead capturado (Habiticon)!\n\nNome: ${currentState.data.nome}\nTelefone: ${currentState.data.telefone}\nE-mail: ${currentState.data.email}`;
            
            sendNotification(nomeDoCanal, mensagemNotificacao);
            console.log(`[TELEGRAM] Notificação enviada para o canal: ${nomeDoCanal}`);
        }
        // ### FIM DA ADIÇÃO ###

        await client.sendMessage(chatId, "✅ *Cadastro concluído com sucesso!*\n\nSeus dados foram encaminhados para um de nossos consultores especializados.");
        await client.sendMessage(chatId, "_Por favor, aguarde um instante. Em breve, ele(a) entrará em contato por aqui mesmo para dar sequência ao seu sonho da casa própria!_ 🏡");
        currentState.state = STATES.LEAD_CAPTURADO;
    } else {
                await client.sendMessage(chatId, "😕 Humm, este e-mail não parece válido.\n\nPor favor, verifique se digitou corretamente e incluiu um domínio conhecido (como @gmail.com, @hotmail.com, etc.).\n\n_Se preferir, digite *menu* para voltar ao início._");
            }
            break;

        case STATES.LEAD_CAPTURADO:
        case STATES.LEAD_PARCIAL_CAPTURADO:
            await client.sendMessage(chatId, "Olá! 😊 Sua solicitação já foi registrada e um consultor entrará em contato em breve.\n\n_Se desejar ver as opções novamente, digite *menu*._");
            break;
        
        case STATES.ATENDIMENTO_HUMANO:
            console.log(`[ATENDIMENTO HUMANO] Mensagem de ${chatId} ignorada pelo bot.`);
            break;
    }
    chatStates.set(chatId, currentState);
    console.log(`[ESTADO] Estado de ${chatId} atualizado para: ${currentState.state}`);
});

// 7. SISTEMA DE RECAPTURA
// =================================
setInterval(async () => {
    const agora = Date.now();
    for (const [chatId, state] of chatStates.entries()) {
        const tempoInativo = agora - state.lastInteraction;
        const estadosDeCapturaInatividade = [STATES.AGUARDANDO_NOME, STATES.AGUARDANDO_EMAIL, STATES.AGUARDANDO_OPCAO_CONSULTOR];
        if (!estadosDeCapturaInatividade.includes(state.state)) continue;

        if (tempoInativo > TEMPO_ENVIO_PARCIAL) {
            state.data.telefone = chatId.replace('@c.us', '');
            await enviarLeadParaMake(state.data);
            state.state = STATES.LEAD_PARCIAL_CAPTURADO;
            chatStates.set(chatId, state);
            await client.sendMessage(chatId, "Olá! Notei que não conseguimos concluir seu cadastro, mas não se preocupe! Um de nossos consultores recebeu seus dados e entrará em contato para te ajudar. 😊");
            continue;
        }

        if (tempoInativo > TEMPO_LEMBRETE && !state.reminderSent) {
            await client.sendMessage(chatId, "👋 Olá! Notei que a nossa conversa ficou parada.\n\nPodemos continuar com o seu cadastro? Basta responder à minha última pergunta. Se mudou de ideias, não há problema, basta digitar *encerrar*.");
            state.reminderSent = true;
            chatStates.set(chatId, state);
        }
    }
}, 60 * 1000);

// 8. INICIALIZAÇÃO DO SERVIDOR
// =================================
app.listen(PORT, () => {
    console.log(`[SERVIDOR] API de status rodando na porta ${PORT}.`);
    client.initialize().catch(err => {
        console.error("[BOT] Erro CRÍTICO na inicialização do cliente:", err);
    });
});