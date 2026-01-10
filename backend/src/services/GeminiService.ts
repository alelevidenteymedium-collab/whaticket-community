import { GoogleGenerativeAI } from "@google/generative-ai";

class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error("GEMINI_API_KEY no está configurada");
      return;
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
  }

  async generateResponse(prompt: string, conversationHistory: string = ""): Promise<string> {
    try {
      if (!this.model) {
        return "Error: Gemini API no está configurada correctamente";
      }

      const fullPrompt = conversationHistory 
        ? `Historial de conversación:\n${conversationHistory}\n\nNuevo mensaje: ${prompt}\n\nResponde de forma amigable y profesional:`
        : `${prompt}\n\nResponde de forma amigable y profesional:`;

      const result = await this.model.generateContent(fullPrompt);
      const response = await result.response;
      const text = response.text();

      return text;
    } catch (error) {
      console.error("Error en Gemini API:", error);
      return "Lo siento, hubo un error al procesar tu mensaje. ¿Podrías intentar de nuevo?";
    }
  }

  async shouldAutoRespond(message: string): Promise<boolean> {
    // Lógica para decidir si responder automáticamente
    // Por ahora, responde a todos los mensajes que no vengan de un agente
    return true;
  }
}

export default new GeminiService();
