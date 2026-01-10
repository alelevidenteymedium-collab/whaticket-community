import express from "express";
const router = express.Router();

// Verificación del webhook (requerido por Facebook)
router.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN;
  
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recibir mensajes de Instagram
router.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object === "instagram") {
      body.entry.forEach((entry: any) => {
        entry.messaging.forEach(async (event: any) => {
          if (event.message) {
            const senderId = event.sender.id;
            const messageText = event.message.text;

            // Generar respuesta con Gemini
            const response = await GeminiService.generateResponse(messageText);
            
            // Enviar respuesta
            await InstagramService.sendMessage(senderId, response);
          }
        });
      });

      res.status(200).send("EVENT_RECEIVED");
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("Error en webhook de Instagram:", error);
    res.sendStatus(500);
  }
});

export default router;
