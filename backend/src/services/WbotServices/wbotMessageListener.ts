import { join } from "path";
import { promisify } from "util";
import { writeFile } from "fs";
import * as Sentry from "@sentry/node";

import {
  Contact as WbotContact,
  Message as WbotMessage,
  MessageAck,
  Client
} from "whatsapp-web.js";

import Contact from "../../models/Contact";
import Ticket from "../../models/Ticket";
import Message from "../../models/Message";

import { getIO } from "../../libs/socket";
import CreateMessageService from "../MessageServices/CreateMessageService";
import { logger } from "../../utils/logger";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";
import { debounce } from "../../helpers/Debounce";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import CreateContactService from "../ContactServices/CreateContactService";
import GetContactService from "../ContactServices/GetContactService";
import formatBody from "../../helpers/Mustache";

// ✨ NUEVO: Importar servicio de Gemini
import GeminiService from "../GeminiService";

interface Session extends Client {
  id?: number;
}

const writeFileAsync = promisify(writeFile);

const verifyContact = async (msgContact: WbotContact): Promise<Contact> => {
  const profilePicUrl = await msgContact.getProfilePicUrl();

  const contactData = {
    name: msgContact.name || msgContact.pushname || msgContact.id.user,
    number: msgContact.id.user,
    profilePicUrl,
    isGroup: msgContact.isGroup
  };

  const contact = CreateOrUpdateContactService(contactData);

  return contact;
};

const verifyQuotedMessage = async (
  msg: WbotMessage
): Promise<Message | null> => {
  if (!msg.hasQuotedMsg) return null;

  const wbotQuotedMsg = await msg.getQuotedMessage();

  const quotedMsg = await Message.findOne({
    where: { id: wbotQuotedMsg.id.id }
  });

  if (!quotedMsg) return null;

  return quotedMsg;
};

function makeRandomId(length: number) {
  let result = "";
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;
  let counter = 0;
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
    counter += 1;
  }
  return result;
}

const verifyMediaMessage = async (
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
): Promise<Message> => {
  const quotedMsg = await verifyQuotedMessage(msg);

  const media = await msg.downloadMedia();

  if (!media) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  let randomId = makeRandomId(5);

  if (!media.filename) {
    const ext = media.mimetype.split("/")[1].split(";")[0];
    media.filename = `${randomId}-${new Date().getTime()}.${ext}`;
  } else {
    media.filename =
      media.filename.split(".").slice(0, -1).join(".") +
      "." +
      randomId +
      "." +
      media.filename.split(".").slice(-1);
  }

  try {
    await writeFileAsync(
      join(__dirname, "..", "..", "..", "public", media.filename),
      media.data,
      "base64"
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error(err);
  }

  const messageData = {
    id: msg.id.id,
    ticketId: ticket.id,
    contactId: msg.fromMe ? undefined : contact.id,
    body: msg.body || media.filename,
    fromMe: msg.fromMe,
    read: msg.fromMe,
    mediaUrl: media.filename,
    mediaType: media.mimetype.split("/")[0],
    quotedMsgId: quotedMsg?.id
  };

  await ticket.update({ lastMessage: msg.body || media.filename });
  const newMessage = await CreateMessageService({ messageData });

  return newMessage;
};

const verifyMessage = async (
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  if (msg.type === "location") msg = prepareLocation(msg);

  const quotedMsg = await verifyQuotedMessage(msg);
  const messageData = {
    id: msg.id.id,
    ticketId: ticket.id,
    contactId: msg.fromMe ? undefined : contact.id,
    body: msg.body,
    fromMe: msg.fromMe,
    mediaType: msg.type,
    read: msg.fromMe,
    quotedMsgId: quotedMsg?.id
  };

  // @ts-ignore
  await ticket.update({
    lastMessage:
      msg.type === "location"
        ? msg.location.description
          ? "Localization - " + msg.location.description.split("\\n")[0]
          : "Localization"
        : msg.body
  });

  await CreateMessageService({ messageData });
};

const prepareLocation = (msg: WbotMessage): WbotMessage => {
  let gmapsUrl =
    "https://maps.google.com/maps?q=" +
    msg.location.latitude +
    "%2C" +
    msg.location.longitude +
    "&z=17&hl=pt-BR";

  msg.body = "data:image/png;base64," + msg.body + "|" + gmapsUrl;

  // @ts-ignore
  msg.body +=
    "|" +
    (msg.location.description
      ? msg.location.description
      : msg.location.latitude + ", " + msg.location.longitude);

  return msg;
};

const verifyQueue = async (
  wbot: Session,
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  const { queues, greetingMessage } = await ShowWhatsAppService(wbot.id!);

  if (queues.length === 1) {
    await UpdateTicketService({
      ticketData: { queueId: queues[0].id },
      ticketId: ticket.id
    });

    return;
  }

  const selectedOption = msg.body;

  const choosenQueue = queues[+selectedOption - 1];

  if (choosenQueue) {
    await UpdateTicketService({
      ticketData: { queueId: choosenQueue.id },
      ticketId: ticket.id
    });

    const body = formatBody(`\u200e${choosenQueue.greetingMessage}`, contact);

    const sentMessage = await wbot.sendMessage(`${contact.number}@c.us`, body);

    await verifyMessage(sentMessage, ticket, contact);
  } else {
    let options = "";

    queues.forEach((queue, index) => {
      options += `*${index + 1}* - ${queue.name}\n`;
    });

    const body = formatBody(`\u200e${greetingMessage}\n${options}`, contact);

    const debouncedSentMessage = debounce(
      async () => {
        const sentMessage = await wbot.sendMessage(
          `${contact.number}@c.us`,
          body
        );
        verifyMessage(sentMessage, ticket, contact);
      },
      3000,
      ticket.id
    );

    debouncedSentMessage();
  }
};

const isValidMsg = (msg: WbotMessage): boolean => {
  if (msg.from === "status@broadcast") return false;
  if (
    msg.type === "chat" ||
    msg.type === "audio" ||
    msg.type === "ptt" ||
    msg.type === "video" ||
    msg.type === "image" ||
    msg.type === "document" ||
    msg.type === "vcard" ||
    msg.type === "sticker" ||
    msg.type === "location"
  )
    return true;
  return false;
};

// ✨ NUEVA FUNCIÓN: Obtener historial de conversación
const getConversationHistory = async (ticketId: number): Promise<string> => {
  try {
    const messages = await Message.findAll({
      where: { ticketId },
      order: [["createdAt", "DESC"]],
      limit: 10, // Últimos 10 mensajes
      include: ["contact"]
    });

    if (!messages || messages.length === 0) {
      return "";
    }

    // Formatear mensajes para el contexto de Gemini
    const history = messages
      .reverse()
      .map((msg: any) => {
        const sender = msg.fromMe ? "Asistente" : "Cliente";
        return `${sender}: ${msg.body}`;
      })
      .join("\n");

    return history;
  } catch (error) {
    logger.error(`Error obteniendo historial: ${error}`);
    return "";
  }
};

// ✨ NUEVA FUNCIÓN: Determinar fase del ticket
const getTicketPhase = (ticket: Ticket): "sales" | "ritual" | "personal" => {
  // Si tiene un campo custom para marcar la fase, usarlo aquí
  // Por ahora, usamos lógica basada en el estado
  
  // Verificar si el ticket tiene metadata para fase ritual
  // Puedes agregar un campo "botPhase" en el modelo Ticket o usar otro método
  
  // Por defecto, si no hay agente asignado, usar fase de ventas
  return "sales";
};

// ... (código anterior sin cambios hasta handleGeminiAutoResponse)

// ✅ NUEVA FUNCIÓN: Respuesta automática con Gemini (MEJORADA)
const handleGeminiAutoResponse = async (
  wbot: Session,
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  try {
    // 🧪 CONFIGURACIÓN DE PRUEBA
    const TEST_MODE = process.env.GEMINI_TEST_MODE === "true";
    const TEST_NUMBER = process.env.GEMINI_TEST_NUMBER || "51986848215";
    
    // Normalizar número (quitar caracteres no numéricos)
    const normalizedContactNumber = contact.number.replace(/\D/g, '');
    const normalizedTestNumber = TEST_NUMBER.replace(/\D/g, '');
    
    if (TEST_MODE) {
      logger.info(`🧪 TEST MODE ACTIVO - Número objetivo: ${normalizedTestNumber}`);
      logger.info(`📱 Mensaje recibido de: ${normalizedContactNumber}`);
      
      if (normalizedContactNumber !== normalizedTestNumber) {
        logger.info(`🚫 Test mode: Ignorando mensaje de ${normalizedContactNumber}`);
        return;
      }
      
      logger.info(`✅ Test mode: Procesando mensaje de ${normalizedContactNumber}`);
    }

    // ⚙️ ID del agente (obtener de variable de entorno o usar 1 por defecto)
    const AGENT_USER_ID = parseInt(process.env.AGENT_USER_ID || "1");
    
    logger.info(`🔧 Configuración: AGENT_USER_ID=${AGENT_USER_ID}, TEST_MODE=${TEST_MODE}`);

    // Determinar la fase del ticket
    let phase: "sales" | "ritual" | "personal" = "sales";

    // Si el ticket está cerrado, reabrirlo automáticamente
    if (ticket.status === "closed") {
      await UpdateTicketService({
        ticketData: { status: "pending" },
        ticketId: ticket.id
      });
      logger.info(`🔄 Ticket ${ticket.id} reabierto automáticamente`);
      phase = "sales";
    }

    // Si hay agente asignado, no usar bot
    if (ticket.userId) {
      logger.info(`👤 Ticket ${ticket.id} tiene agente ${ticket.userId} asignado, bot inactivo`);
      return;
    }

    // Si no tiene cola, esperar menú inicial
    if (!ticket.queueId) {
      logger.info(`⏳ Ticket ${ticket.id} sin cola asignada, esperando menú`);
      return;
    }

    // Verificar si Gemini está configurado
    if (!GeminiService.isConfigured()) {
      logger.warn(`⚠️ Gemini no configurado, saltando respuesta automática`);
      return;
    }

    logger.info(`🤖 Procesando con bot de ${phase} para ticket ${ticket.id}`);
    logger.info(`📝 Mensaje del cliente: "${msg.body}"`);

    // Obtener historial de conversación
    const conversationHistory = await getConversationHistory(ticket.id);
    
    if (conversationHistory) {
      logger.info(`📚 Historial cargado (${conversationHistory.split('\n').length} mensajes)`);
    }

    // Generar respuesta con Gemini
    const { response, action } = await GeminiService.generateResponse(
      msg.body,
      conversationHistory,
      {
        phase,
        hasPaid: false,
        ritualInstructionsGiven: false
      }
    );

    if (!response) {
      logger.warn(`⚠️ Gemini no generó respuesta para ticket ${ticket.id}`);
      return;
    }

    logger.info(`💬 Gemini generó respuesta: "${response.substring(0, 100)}..."`);

    // Procesar acciones especiales
    if (action === "ASSIGN_TO_AGENT") {
      await UpdateTicketService({
        ticketData: { userId: AGENT_USER_ID, status: "open" },
        ticketId: ticket.id
      });
      logger.info(`👤 Ticket ${ticket.id} asignado al agente ${AGENT_USER_ID} por solicitud del cliente`);
    }

    if (action === "PAYMENT_DETECTED") {
      await UpdateTicketService({
        ticketData: { userId: AGENT_USER_ID, status: "open" },
        ticketId: ticket.id
      });
      logger.info(`💰 Pago detectado en ticket ${ticket.id}, asignado a agente ${AGENT_USER_ID} para verificación`);
    }

    if (action === "RITUAL_INSTRUCTIONS_COMPLETE") {
      await UpdateTicketService({
        ticketData: { userId: AGENT_USER_ID, status: "open" },
        ticketId: ticket.id
      });
      logger.info(`🌙 Instrucciones completadas en ticket ${ticket.id}, asignado a agente ${AGENT_USER_ID}`);
    }

    // Enviar respuesta al cliente
    const formattedResponse = `\u200e${response}`;
    
    logger.info(`📤 Enviando respuesta al cliente...`);
    
    const sentMessage = await wbot.sendMessage(
      `${contact.number}@c.us`,
      formattedResponse
    );

    await verifyMessage(sentMessage, ticket, contact);

    logger.info(`✅ Bot de ${phase} respondió exitosamente al ticket ${ticket.id}`);
    
  } catch (error: any) {
    logger.error(`❌ Error en respuesta automática con Gemini para ticket ${ticket.id}:`, error);
    logger.error(`📋 Stack trace:`, error.stack);
    Sentry.captureException(error);
  }
};

// ... (resto del código sin cambios)



// ... (todo el código anterior hasta handleMessage)

const handleMessage = async (
  msg: WbotMessage,
  wbot: Session
): Promise<void> => {
  // ✅ LOG 1: Mensaje recibido
  logger.info(`📨 ============ MENSAJE RECIBIDO ============`);
  logger.info(`📱 De: ${msg.from}`);
  logger.info(`📝 Cuerpo: ${msg.body}`);
  logger.info(`🔄 Es de mí: ${msg.fromMe}`);
  logger.info(`📋 Tipo: ${msg.type}`);

  if (!isValidMsg(msg)) {
    logger.info(`❌ Mensaje no válido, ignorando`);
    return;
  }

  try {
    let msgContact: WbotContact;
    let groupContact: Contact | undefined;

    if (msg.fromMe) {
      if (/\u200e/.test(msg.body[0])) return;

      if (
        !msg.hasMedia &&
        msg.type !== "location" &&
        msg.type !== "chat" &&
        msg.type !== "vcard"
      )
        return;

      msgContact = await wbot.getContactById(msg.to);
    } else {
      msgContact = await msg.getContact();
    }

    const chat = await msg.getChat();

    if (chat.isGroup) {
      logger.info(`👥 Mensaje de grupo, ignorando`);
      let msgGroupContact;

      if (msg.fromMe) {
        msgGroupContact = await wbot.getContactById(msg.to);
      } else {
        msgGroupContact = await wbot.getContactById(msg.from);
      }

      groupContact = await verifyContact(msgGroupContact);
    }
    
    const whatsapp = await ShowWhatsAppService(wbot.id!);
    const unreadMessages = msg.fromMe ? 0 : chat.unreadCount;
    const contact = await verifyContact(msgContact);

    // ✅ LOG 2: Contacto identificado
    logger.info(`👤 Contacto identificado: ${contact.name} (${contact.number})`);

    if (
      unreadMessages === 0 &&
      whatsapp.farewellMessage &&
      formatBody(whatsapp.farewellMessage, contact) === msg.body
    )
      return;

    const ticket = await FindOrCreateTicketService(
      contact,
      wbot.id!,
      unreadMessages,
      groupContact
    );

    // ✅ LOG 3: Ticket creado/encontrado
    logger.info(`🎫 Ticket ID: ${ticket.id}`);
    logger.info(`🎫 Ticket Status: ${ticket.status}`);
    logger.info(`🎫 Ticket userId: ${ticket.userId || 'Sin asignar'}`);
    logger.info(`🎫 Ticket queueId: ${ticket.queueId || 'Sin cola'}`);

    // Comandos especiales para el agente
    if (msg.fromMe && msg.body.startsWith("/")) {
      const command = msg.body.toLowerCase();
      
      if (command === "/activar-ritual") {
        logger.info(`🔮 Comando /activar-ritual ejecutado en ticket ${ticket.id}`);
        
        await UpdateTicketService({
          ticketData: { userId: undefined, status: "pending" },
          ticketId: ticket.id
        });
        
        const confirmMsg = await wbot.sendMessage(
          `${contact.number}@c.us`,
          "\u200e✅ Fase de ritual activada. El bot comenzará a dar instrucciones."
        );
        await verifyMessage(confirmMsg, ticket, contact);
        
        return;
      }
      
      if (command === "/info") {
        const info = `📊 Info del Ticket #${ticket.id}
👤 Usuario asignado: ${ticket.userId || "Ninguno (Bot activo)"}
📋 Estado: ${ticket.status}
🎯 Cola: ${ticket.queueId || "Sin cola"}`;
        
        const infoMsg = await wbot.sendMessage(`${contact.number}@c.us`, `\u200e${info}`);
        await verifyMessage(infoMsg, ticket, contact);
        return;
      }
    }

    if (msg.hasMedia) {
      logger.info(`🖼️ Mensaje con media`);
      await verifyMediaMessage(msg, ticket, contact);
    } else {
      await verifyMessage(msg, ticket, contact);
    }

    // ✅ LOG 4: Verificar si debe pasar por el menú de colas
    if (
      !ticket.queue &&
      !chat.isGroup &&
      !msg.fromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1
    ) {
      logger.info(`📋 Enviando menú de colas`);
      await verifyQueue(wbot, msg, ticket, contact);
    }

    // ✅ LOG 5: Verificar condiciones para respuesta automática
    logger.info(`🤖 ========== VERIFICANDO BOT ==========`);
    logger.info(`🤖 msg.fromMe: ${msg.fromMe}`);
    logger.info(`🤖 chat.isGroup: ${chat.isGroup}`);
    logger.info(`🤖 msg.type: ${msg.type}`);
    logger.info(`🤖 ticket.queueId: ${ticket.queueId}`);

    // Respuesta automática con Gemini
    if (
      !msg.fromMe &&
      !chat.isGroup &&
      msg.type === "chat" &&
      ticket.queueId
    ) {
      logger.info(`✅ Todas las condiciones cumplidas, llamando a handleGeminiAutoResponse`);
      await handleGeminiAutoResponse(wbot, msg, ticket, contact);
    } else {
      logger.info(`❌ Condiciones NO cumplidas para bot:`);
      if (msg.fromMe) logger.info(`   - Es mensaje propio`);
      if (chat.isGroup) logger.info(`   - Es mensaje de grupo`);
      if (msg.type !== "chat") logger.info(`   - Tipo no es 'chat': ${msg.type}`);
      if (!ticket.queueId) logger.info(`   - No tiene cola asignada`);
    }

    if (msg.type === "vcard") {
      try {
        const array = msg.body.split("\n");
        const obj = [];
        let contact = "";
        for (let index = 0; index < array.length; index++) {
          const v = array[index];
          const values = v.split(":");
          for (let ind = 0; ind < values.length; ind++) {
            if (values[ind].indexOf("+") !== -1) {
              obj.push({ number: values[ind] });
            }
            if (values[ind].indexOf("FN") !== -1) {
              contact = values[ind + 1];
            }
          }
        }
        for await (const ob of obj) {
          const cont = await CreateContactService({
            name: contact,
            number: ob.number.replace(/\D/g, "")
          });
        }
      } catch (error) {
        console.log(error);
      }
    }
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`❌ Error handling whatsapp message: ${err}`);
  }
};

// ... (resto del código sin cambios)

const handleMsgAck = async (msg: WbotMessage, ack: MessageAck) => {
  await new Promise(r => setTimeout(r, 500));

  const io = getIO();

  try {
    const messageToUpdate = await Message.findByPk(msg.id.id, {
      include: [
        "contact",
        {
          model: Message,
          as: "quotedMsg",
          include: ["contact"]
        }
      ]
    });
    if (!messageToUpdate) {
      return;
    }
    await messageToUpdate.update({ ack });

    io.to(messageToUpdate.ticketId.toString()).emit("appMessage", {
      action: "update",
      message: messageToUpdate
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error handling message ack. Err: ${err}`);
  }
};

const wbotMessageListener = (wbot: Session): void => {
  wbot.on("message_create", async msg => {
    handleMessage(msg, wbot);
  });

  wbot.on("media_uploaded", async msg => {
    handleMessage(msg, wbot);
  });

  wbot.on("message_ack", async (msg, ack) => {
    handleMsgAck(msg, ack);
  });
};

export { wbotMessageListener, handleMessage };
