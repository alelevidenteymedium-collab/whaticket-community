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

// ✨ NUEVA FUNCIÓN: Respuesta automática con Gemini (CON FASES)
const handleGeminiAutoResponse = async (
  wbot: Session,
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  try {
        const TEST_MODE = true; // 👈 Cambiar a false cuando termines las pruebas
    const TEST_NUMBER = "51986848215"; // 👈 CAMBIAR POR TU NÚMERO DE PRUEBA (sin +, sin espacios)
    
    if (TEST_MODE && contact.number !== TEST_NUMBER) {
      logger.info(`🚫 Test mode: Ignorando mensaje de ${contact.number} (no es el número de prueba)`);
      return; // No hacer nada, ignorar este mensaje
    }
    
    if (TEST_MODE) {
      logger.info(`✅ Test mode: Procesando mensaje de ${contact.number} (número de prueba)`);
    }


    
    // ⚙️ CONFIGURA TU ID DE USUARIO AQUÍ
    const AGENT_USER_ID = 1; // 👈 CAMBIAR POR TU ID REAL

    // Determinar la fase del ticket
    let phase: "sales" | "ritual" | "personal" = "sales";

    // Si el ticket está cerrado, reabrirlo automáticamente
    if (ticket.status === "closed") {
      await UpdateTicketService({
        ticketData: { status: "pending" },
        ticketId: ticket.id
      });
      logger.info(`🔄 Ticket ${ticket.id} reabierto automáticamente`);
      phase = "sales"; // Volver a fase de ventas
    }
    // Si hay agente asignado, no usar bot
    if (ticket.userId) {
      logger.info(`👤 Ticket ${ticket.id} tiene agente asignado, bot inactivo`);
      return;
    }

    // Si no tiene cola, esperar menú inicial
    if (!ticket.queueId) {
      return;
    }

    // Verificar si el ticket está marcado para fase ritual
    // Puedes usar un campo custom del ticket para esto
    // Por ejemplo: if (ticket.botPhase === "ritual") phase = "ritual";
    
    logger.info(`🤖 Procesando con bot de ${phase} para ticket ${ticket.id}`);

    // Obtener historial de conversación
    const conversationHistory = await getConversationHistory(ticket.id);

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
      logger.warn("Gemini no generó respuesta");
      return;
    }

    // Procesar acciones especiales
    if (action === "ASSIGN_TO_AGENT") {
      // Cliente solicita atención personal
      await UpdateTicketService({
        ticketData: { userId: AGENT_USER_ID, status: "open" },
        ticketId: ticket.id
      });
      logger.info(`👤 Ticket ${ticket.id} asignado al agente por solicitud del cliente`);
    }

    if (action === "PAYMENT_DETECTED") {
      // Cliente menciona pago, asignar para verificación
      await UpdateTicketService({
        ticketData: { userId: AGENT_USER_ID, status: "open" },
        ticketId: ticket.id
      });
      logger.info(`💰 Pago detectado en ticket ${ticket.id}, asignado para verificación`);
    }

    if (action === "RITUAL_INSTRUCTIONS_COMPLETE") {
      // Bot de ritual terminó, asignar para seguimiento personal
      await UpdateTicketService({
        ticketData: { userId: AGENT_USER_ID, status: "open" },
        ticketId: ticket.id
      });
      logger.info(`🌙 Instrucciones completadas en ticket ${ticket.id}, asignado para seguimiento`);
    }

    // Enviar respuesta al cliente
    const formattedResponse = `\u200e${response}`;
    const sentMessage = await wbot.sendMessage(
      `${contact.number}@c.us`,
      formattedResponse
    );

    // Guardar mensaje en base de datos
    await verifyMessage(sentMessage, ticket, contact);

    logger.info(`✅ Bot de ${phase} respondió al ticket ${ticket.id}`);
  } catch (error) {
    logger.error(`❌ Error en respuesta automática con Gemini:`, error);
    Sentry.captureException(error);
  }
};

const handleMessage = async (
  msg: WbotMessage,
  wbot: Session
): Promise<void> => {
  if (!isValidMsg(msg)) {
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

  // ✨ NUEVO: Comandos especiales para el agente (solo mensajes tuyos)
  if (msg.fromMe && msg.body.startsWith("/")) {
    const command = msg.body.toLowerCase();
    
    if (command === "/activar-ritual") {
      // Marcar ticket para fase de ritual
      logger.info(`🔮 Comando /activar-ritual ejecutado en ticket ${ticket.id}`);
      
      // Aquí podrías guardar en un campo custom del ticket
      // Por ahora, desasignamos el ticket para que el bot tome control
      await UpdateTicketService({
        ticketData: { userId: undefined, status: "pending" }, // 👈 CAMBIO AQUÍ
        ticketId: ticket.id
      });
      
      // Mensaje de confirmación (opcional)
      const confirmMsg = await wbot.sendMessage(
        `${contact.number}@c.us`,
        "\u200e✅ Fase de ritual activada. El bot comenzará a dar instrucciones."
      );
      await verifyMessage(confirmMsg, ticket, contact);
      
      return; // No procesar más
    }
      
      if (command === "/info") {
        // Mostrar información del ticket
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
      await verifyMediaMessage(msg, ticket, contact);
    } else {
      await verifyMessage(msg, ticket, contact);
    }

    if (
      !ticket.queue &&
      !chat.isGroup &&
      !msg.fromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1
    ) {
      await verifyQueue(wbot, msg, ticket, contact);
    }

    // ✨ NUEVO: Respuesta automática con Gemini (DESPUÉS del menú de colas)
    // Solo para mensajes de texto del cliente en tickets con cola asignada
    if (
      !msg.fromMe &&
      !chat.isGroup &&
      msg.type === "chat" &&
      ticket.queueId
    ) {
      await handleGeminiAutoResponse(wbot, msg, ticket, contact);
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
    logger.error(`Error handling whatsapp message: Err: ${err}`);
  }
};

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
