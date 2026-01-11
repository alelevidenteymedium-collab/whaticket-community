import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../utils/logger";

interface BotContext {
  phase: "sales" | "ritual" | "personal";
  hasPaid: boolean;
  ritualInstructionsGiven: boolean;
}

class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;
  private model: any = null;

  // Prompts para cada bot
  private readonly SALES_BOT_PROMPT = `Eres un asistente virtual especializado en servicios de videncia y rituales esotéricos.

Tu objetivo es:
- Explicar los servicios disponibles: lecturas de tarot, videncia, rituales de amor, protección, abundancia
- Responder preguntas sobre precios, duración y beneficios
- Ser místico pero profesional y confiable
- Generar confianza en el cliente
- Detectar cuando el cliente quiere hablar directamente con la vidente

Servicios que ofrecemos:
- Lectura de Tarot: Consulta sobre amor, trabajo, familia ($30-50 USD)
- Videncia: Visión del futuro y guía espiritual ($50-100 USD)
- Rituales de Amor: Para atraer o recuperar pareja ($100-200 USD)
- Rituales de Protección: Contra energías negativas ($80-150 USD)
- Rituales de Abundancia: Para prosperidad y dinero ($100-200 USD)

IMPORTANTE:
- Si el cliente pregunta "cuánto cuesta" o "precio", explica los rangos según el servicio
- Si el cliente dice frases como "quiero hablar contigo", "necesito atención personal", "es urgente", "quiero contratar", responde: "SOLICITAR_ATENCION_PERSONAL"
- Si el cliente menciona que ya realizó un pago o envió comprobante, responde: "PAGO_DETECTADO"
- Nunca des instrucciones de rituales, eso es información confidencial que solo se da después del pago

Tono: Místico, empático, profesional, usa emojis místicos ocasionalmente ✨🔮🌙`;

  private readonly RITUAL_BOT_PROMPT = `Eres un asistente especializado en dar instrucciones para rituales esotéricos.

El cliente YA PAGÓ por el servicio. Tu trabajo es:
- Dar instrucciones claras y paso a paso del ritual
- Explicar qué materiales necesita
- Indicar días y horarios propicios (lunas, días de la semana)
- Advertencias y precauciones importantes
- Responder dudas sobre el procedimiento

Estructura de instrucciones:
1. Materiales necesarios (velas, hierbas, incienso, etc.)
2. Preparación del espacio (limpieza energética)
3. Mejor momento para realizar (día, hora, fase lunar)
4. Paso a paso del ritual
5. Cierre y precauciones

IMPORTANTE:
- Si el cliente dice "entendido", "ya tengo todo", "listo", "perfecto", "ok", o similar, responde: "RITUAL_COMPLETO"
- Sé detallado pero claro
- Pregunta si tiene dudas antes de dar por terminado
- Mantén un tono serio y respetuoso

Ejemplo de materiales:
- 1 vela roja (amor) o blanca (protección) o verde (abundancia)
- Incienso de sándalo o mirra
- Pétalos de rosa o lavanda
- Un recipiente con agua
- Papel y lápiz rojo

Tono: Serio, instructivo, místico 🕯️🌿`;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      logger.warn("⚠️ GEMINI_API_KEY no está configurada. Las respuestas automáticas no funcionarán.");
      return;
    }

    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
      logger.info("✅ Gemini AI inicializado correctamente");
    } catch (error) {
      logger.error("❌ Error inicializando Gemini AI:", error);
    }
  }

  async generateResponse(
    prompt: string,
    conversationHistory: string = "",
    context: BotContext
  ): Promise<{ response: string | null; action?: string }> {
    try {
      if (!this.model) {
        logger.warn("Gemini no está configurado. Saltando respuesta automática.");
        return { response: null };
      }

      // Seleccionar el bot apropiado según la fase
      let systemPrompt: string;
      
      if (context.phase === "sales") {
        systemPrompt = this.SALES_BOT_PROMPT;
      } else if (context.phase === "ritual") {
        systemPrompt = this.RITUAL_BOT_PROMPT;
      } else {
        // Fase personal, no usar bot
        return { response: null };
      }

      const fullPrompt = conversationHistory 
        ? `${systemPrompt}\n\nHistorial de conversación:\n${conversationHistory}\n\nNuevo mensaje del cliente: ${prompt}\n\nTu respuesta:`
        : `${systemPrompt}\n\nMensaje del cliente: ${prompt}\n\nTu respuesta:`;

      const result = await this.model.generateContent(fullPrompt);
      const response = await result.response;
      const text = response.text().trim();

      // Detectar acciones especiales
      if (text.includes("SOLICITAR_ATENCION_PERSONAL")) {
        return {
          response: "Un momento, te estoy conectando con nuestra vidente principal. Ella te atenderá personalmente para brindarte la mejor experiencia. ✨",
          action: "ASSIGN_TO_AGENT"
        };
      }

      if (text.includes("PAGO_DETECTADO")) {
        return {
          response: "Gracias por tu pago. Un momento mientras verificamos tu transacción. Te contactaremos pronto. 💫",
          action: "PAYMENT_DETECTED"
        };
      }

      if (text.includes("RITUAL_COMPLETO")) {
        return {
          response: "Perfecto. Ahora nuestra vidente te contactará personalmente para acompañarte en el proceso y resolver cualquier duda adicional. Muchas gracias por tu confianza. 🌙✨",
          action: "RITUAL_INSTRUCTIONS_COMPLETE"
        };
      }

      logger.info(`🤖 Bot de ${context.phase} respondió (${text.length} caracteres)`);
      return { response: text };

    } catch (error: any) {
      logger.error("❌ Error generando respuesta con Gemini:", error.message);
      return { response: null };
    }
  }

  isConfigured(): boolean {
    return this.model !== null;
  }
}

export default new GeminiService();
