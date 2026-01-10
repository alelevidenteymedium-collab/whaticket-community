import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../utils/logger";

class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;
  private model: any = null;

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

  async generateResponse(prompt: string, conversationHistory: string = ""): Promise<string | null> {
    try {
      if (!this.model) {
        logger.warn("Gemini no está configurado. Saltando respuesta automática.");
        return null;
      }

      // Crear prompt contextual
      const systemPrompt = `Eres un asistente virtual amigable y profesional para atención al cliente por WhatsApp.

Instrucciones:
- Sé cordial, empático y profesional
- Responde de forma clara y concisa
- Si no sabes algo, sé honesto
- Ofrece ayuda adicional cuando sea apropiado
- Usa un tono conversacional natural`;

      const fullPrompt = conversationHistory 
        ? `${systemPrompt}\n\nHistorial de conversación:\n${conversationHistory}\n\nNuevo mensaje del cliente: ${prompt}\n\nTu respuesta:`
        : `${systemPrompt}\n\nMensaje del cliente: ${prompt}\n\nTu respuesta:`;

      const result = await this.model.generateContent(fullPrompt);
      const response = await result.response;
      const text = response.text();

      if (!text) {
        logger.warn("Gemini devolvió respuesta vacía");
        return null;
      }

      logger.info(`🤖 Gemini generó respuesta (${text.length} caracteres)`);
      return text.trim();

    } catch (error: any) {
      logger.error("❌ Error generando respuesta con Gemini:", error.message);
      return null;
    }
  }

  isConfigured(): boolean {
    return this.model !== null;
  }
}

export default new GeminiService();
