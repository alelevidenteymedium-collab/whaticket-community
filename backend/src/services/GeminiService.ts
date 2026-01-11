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

IMPORTANTE:
- Si el cliente pregunta por precios específicos, menciona que varían según el caso (entre $50-200 USD)
- Si el cliente dice frases como "quiero hablar contigo", "necesito atención personal", "es urgente", responde: "SOLICITAR_ATENCION_PERSONAL"
- Si el cliente menciona que ya realizó un pago, responde: "PAGO_DETECTADO"
- Nunca des instrucciones de rituales, eso es confidencial

Tono: Místico, empático, profesional`;

  private readonly RITUAL_BOT_PROMPT = `Eres un asistente especializado en dar instrucciones para rituales esotéricos.

El cliente YA PAGÓ por el servicio. Tu trabajo es:
- Dar instrucciones claras y paso a paso del ritual
- Explicar qué materiales necesita
- Indicar días y horarios propicios
- Advertencias y precauciones importantes
- Responder dudas sobre el procedimiento

IMPORTANTE:
- Si el cliente dice "entendido", "ya tengo todo", "listo", o similar, responde: "RITUAL_COMPLETO"
- Sé detallado pero claro
- Mantén un tono serio y respetuoso

Información del ritual:
[Aquí irán las instrucciones específicas según el tipo de ritual que el cliente compró]

Tono: Serio, instructivo, místico`;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      logger.warn("⚠️ GEMINI_API_KEY no está configurada");
      return;
    }

    try {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
      logger.info("✅ Gemini AI inicializado");
    } catch (error) {
      logger.error("❌ Error inicializando Gemini:", error);
    }
  }

  async generateResponse(
    prompt: string,
    conversationHistory: string = "",
    context: BotContext
  ): Promise<{ response: string | null; action?: string }> {
    try {
      if (!this.model) {
        logger.warn("Gemini no configurado");
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
        ? `${systemPrompt}\n\nHistorial:\n${conversationHistory}\n\nCliente: ${prompt}\n\nTu respuesta:`
        : `${systemPrompt}\n\nCliente: ${prompt}\n\nTu respuesta:`;

      const result = await this.model.generateContent(fullPrompt);
      const response = await result.response;
      const text = response.text().trim();

      // Detectar acciones especiales
      if (text.includes("SOLICITAR_ATENCION_PERSONAL")) {
        return {
          response: "Un momento, te estoy conectando con nuestra vidente principal. Ella te atenderá personalmente. ✨",
          action: "ASSIGN_TO_AGENT"
        };
      }

      if (text.includes("PAGO_DETECTADO")) {
        return {
          response: "Gracias por tu pago. Un momento mientras verificamos tu transacción. 💫",
          action: "PAYMENT_DETECTED"
        };
      }

      if (text.includes("RITUAL_COMPLETO")) {
        return {
          response: "Perfecto. Ahora nuestra vidente te contactará personalmente para acompañarte en el proceso. 🌙",
          action: "RITUAL_INSTRUCTIONS_COMPLETE"
        };
      }

      logger.info(`🤖 ${context.phase} bot respondió`);
      return { response: text };

    } catch (error: any) {
      logger.error("❌ Error en Gemini:", error.message);
      return { response: null };
    }
  }

  isConfigured(): boolean {
    return this.model !== null;
  }
}

export default new GeminiService();
