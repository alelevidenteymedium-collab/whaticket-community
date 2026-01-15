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
    
    logger.info("🔧 Inicializando GeminiService...");
    logger.info(`🔑 GEMINI_API_KEY presente: ${apiKey ? 'SÍ' : 'NO'}`);
    
    if (!apiKey) {
      logger.error("❌ GEMINI_API_KEY no está configurada en las variables de entorno");
      return;
    }

    logger.info(`🔑 API Key (primeros 20 chars): ${apiKey.substring(0, 20)}...`);
    logger.info(`🔑 API Key (longitud): ${apiKey.length} caracteres`);

    try {
      logger.info("📦 Creando instancia de GoogleGenerativeAI...");
      this.genAI = new GoogleGenerativeAI(apiKey);
      
      logger.info("📦 Obteniendo modelo gemini-pro...");
      this.model = this.genAI.getGenerativeModel({ 
        model: "gemini-pro",
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        },
      });
      
      logger.info("✅ Gemini AI inicializado correctamente");
    } catch (error: any) {
      logger.error("❌ Error inicializando Gemini AI:");
      logger.error(`   Nombre: ${error.name}`);
      logger.error(`   Mensaje: ${error.message}`);
      logger.error(`   Stack: ${error.stack}`);
      this.genAI = null;
      this.model = null;
    }
  }

  async generateResponse(
    prompt: string,
    conversationHistory: string = "",
    context: BotContext
  ): Promise<{ response: string | null; action?: string }> {
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info("🤖 INICIANDO generateResponse");
    logger.info(`📝 Prompt: "${prompt}"`);
    logger.info(`📋 Fase: ${context.phase}`);
    logger.info(`📚 Historial presente: ${conversationHistory ? 'SÍ' : 'NO'}`);
    
    try {
      if (!this.model) {
        logger.error("❌ CRÍTICO: this.model es null");
        logger.error("   Gemini no se inicializó correctamente");
        return { response: null };
      }

      logger.info("✅ Modelo verificado, continuando...");

      let systemPrompt: string;
      
      if (context.phase === "sales") {
        systemPrompt = this.SALES_BOT_PROMPT;
        logger.info("🛍️ Usando prompt de VENTAS");
      } else if (context.phase === "ritual") {
        systemPrompt = this.RITUAL_BOT_PROMPT;
        logger.info("🔮 Usando prompt de RITUAL");
      } else {
        logger.info("👤 Fase PERSONAL - Bot desactivado");
        return { response: null };
      }

      const fullPrompt = conversationHistory 
        ? `${systemPrompt}\n\nHistorial de conversación:\n${conversationHistory}\n\nNuevo mensaje del cliente: ${prompt}\n\nTu respuesta:`
        : `${systemPrompt}\n\nMensaje del cliente: ${prompt}\n\nTu respuesta:`;

      logger.info(`📏 Longitud del prompt completo: ${fullPrompt.length} caracteres`);
      logger.info("📤 Llamando a model.generateContent...");
      
      const startTime = Date.now();
      const result = await this.model.generateContent(fullPrompt);
      const elapsed = Date.now() - startTime;
      
      logger.info(`⏱️ Tiempo de respuesta: ${elapsed}ms`);
      logger.info("📥 Obteniendo response del result...");
      
      const response = result.response;
      
      logger.info("📄 Llamando a response.text()...");
      const text = response.text().trim();

      logger.info(`✅ Texto recibido (${text.length} caracteres)`);
      logger.info(`💬 Primeros 200 chars: "${text.substring(0, 200)}..."`);

      // Detectar acciones especiales
      if (text.includes("SOLICITAR_ATENCION_PERSONAL")) {
        logger.info("🔔 Acción detectada: SOLICITAR_ATENCION_PERSONAL");
        return {
          response: "Un momento, te estoy conectando con nuestra vidente principal. Ella te atenderá personalmente para brindarte la mejor experiencia. ✨",
          action: "ASSIGN_TO_AGENT"
        };
      }

      if (text.includes("PAGO_DETECTADO")) {
        logger.info("🔔 Acción detectada: PAGO_DETECTADO");
        return {
          response: "Gracias por tu pago. Un momento mientras verificamos tu transacción. Te contactaremos pronto. 💫",
          action: "PAYMENT_DETECTED"
        };
      }

      if (text.includes("RITUAL_COMPLETO")) {
        logger.info("🔔 Acción detectada: RITUAL_COMPLETO");
        return {
          response: "Perfecto. Ahora nuestra vidente te contactará personalmente para acompañarte en el proceso y resolver cualquier duda adicional. Muchas gracias por tu confianza. 🌙✨",
          action: "RITUAL_INSTRUCTIONS_COMPLETE"
        };
      }

      logger.info("✅ Respuesta generada exitosamente");
      logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      return { response: text };

    } catch (error: any) {
      logger.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      logger.error("❌ ERROR EN generateResponse");
      logger.error(`📛 Tipo de error: ${error.constructor.name}`);
      logger.error(`📛 Nombre: ${error.name}`);
      logger.error(`📛 Mensaje: ${error.message}`);
      
      // Logs específicos para diferentes tipos de errores
      if (error.message) {
        if (error.message.includes("API key")) {
          logger.error("🔑 ERROR DE API KEY");
          logger.error("   - Verifica que la API key sea válida");
          logger.error("   - Revisa en https://aistudio.google.com/app/apikey");
        }
        
        if (error.message.includes("quota") || error.message.includes("limit")) {
          logger.error("💰 ERROR DE CUOTA/LÍMITE");
          logger.error("   - Has excedido el límite de requests gratuitos");
          logger.error("   - Espera o actualiza tu plan en Google AI Studio");
        }
        
        if (error.message.includes("SAFETY") || error.message.includes("blocked")) {
          logger.error("🚫 CONTENIDO BLOQUEADO");
          logger.error("   - El contenido fue bloqueado por filtros de seguridad");
          logger.error("   - Intenta reformular el prompt");
        }
        
        if (error.message.includes("timeout") || error.message.includes("ECONNREFUSED")) {
          logger.error("🌐 ERROR DE CONEXIÓN");
          logger.error("   - No se pudo conectar a la API de Gemini");
          logger.error("   - Verifica la conectividad de Railway");
        }

        if (error.message.includes("fetch") || error.message.includes("network")) {
          logger.error("🌐 ERROR DE RED");
          logger.error("   - Problema de red entre Railway y Google");
        }
      }
      
      // Log del error completo
      logger.error("📋 Stack trace completo:");
      logger.error(error.stack || "No stack trace disponible");
      
      // Si hay propiedades adicionales en el error
      logger.error("📦 Propiedades del error:");
      logger.error(JSON.stringify(error, null, 2));
      
      logger.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      
      return { response: null };
    }
  }

  isConfigured(): boolean {
    const configured = this.model !== null;
    logger.info(`🔍 isConfigured llamado: ${configured}`);
    return configured;
  }
}

export default new GeminiService();
