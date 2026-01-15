import { Client, LocalAuth } from "whatsapp-web.js";
import { getIO } from "../../libs/socket";
import Whatsapp from "../../models/Whatsapp";
import { logger } from "../../utils/logger";
import { handleMessage } from "./wbotMessageListener";
import AppError from "../../errors/AppError";

interface Session extends Client {
  id?: number;
}

const sessions: Session[] = [];

const syncUnreadMessages = async (wbot: Session) => {
  const chats = await wbot.getChats();

  chats.forEach(async chat => {
    if (chat.unreadCount > 0) {
      const unreadMessages = await chat.fetchMessages({
        limit: chat.unreadCount
      });

      unreadMessages.forEach(async msg => {
        await handleMessage(msg, wbot);
      });

      await chat.sendSeen();
    }
  });
};

export const initWbot = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      logger.info(`🚀 Inicializando sesión de WhatsApp ${whatsapp.name}`);
      logger.info(`🔧 Configurando cliente con timeouts extendidos para Railway`);

      const client = new Client({
        authStrategy: new LocalAuth({ clientId: `session-${whatsapp.id}` }),
        puppeteer: {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-software-rasterizer',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-extensions',
            '--disable-plugins',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-experiments',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--disable-sync',
            '--disable-breakpad',
            '--disable-notifications',
            '--disable-default-apps'
          ],
          timeout: 300000,
          protocolTimeout: 300000
        }
      }) as Session;

      client.id = whatsapp.id;

      logger.info(`⏱️ Timeouts configurados: 300 segundos (5 minutos)`);

      client.on("qr", async qr => {
        logger.info(`📱 QR Code generado para ${whatsapp.name}`);
        logger.info(qr);

        const io = getIO();
        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        await whatsapp.update({ qrcode: qr, status: "qrcode", retries: 0 });
      });

      client.on("authenticated", async () => {
        logger.info(`✅ ${whatsapp.name} AUTENTICADO`);
      });

      client.on("auth_failure", async msg => {
        logger.error(`❌ Fallo de autenticación ${whatsapp.name}: ${msg}`);
        
        const io = getIO();
        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        await whatsapp.update({
          status: "DISCONNECTED",
          qrcode: "",
          retries: 0
        });

        reject(new AppError("ERR_SESSION_EXPIRED"));
      });

      client.on("ready", async () => {
        logger.info(`✅ ${whatsapp.name} LISTO`);

        const io = getIO();
        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        await whatsapp.update({
          status: "CONNECTED",
          qrcode: "",
          retries: 0
        });

        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
        if (sessionIndex === -1) {
          sessions.push(client);
        }

        wbotMessageListener(client);
        resolve(client);
      });

      client.on("disconnected", async reason => {
        logger.warn(`⚠️ ${whatsapp.name} DESCONECTADO: ${reason}`);
        
        const io = getIO();
        io.emit("whatsappSession", {
          action: "update",
          session: whatsapp
        });

        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
        if (sessionIndex !== -1) {
          sessions.splice(sessionIndex, 1);
        }

        await whatsapp.update({
          status: "DISCONNECTED",
          qrcode: "",
          retries: 0
        });

        setTimeout(() => {
          logger.info(`🔄 Intentando reconectar ${whatsapp.name}...`);
          StartWhatsAppSession(whatsapp);
        }, 5000);
      });

      logger.info(`📞 Inicializando cliente WhatsApp...`);
      client.initialize();

    } catch (err) {
      logger.error(`❌ Error inicializando WhatsApp ${whatsapp.name}:`, err);
      reject(err);
    }
  });
};

// ✅ ESTE ES EL EXPORT QUE FALTA
export const StartWhatsAppSession = async (whatsapp: Whatsapp): Promise<void> => {
  await initWbot(whatsapp);
};

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }

  return sessions[sessionIndex];
};

export const removeWbot = (whatsappId: number): void => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

    if (sessionIndex !== -1) {
      sessions[sessionIndex].destroy();
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

// Importar después de las definiciones para evitar referencias circulares
import { wbotMessageListener } from "./wbotMessageListener";
