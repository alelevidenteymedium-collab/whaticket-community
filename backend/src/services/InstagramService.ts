import axios from "axios";

class InstagramService {
  private accessToken: string;

  constructor() {
    this.accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || "";
  }

  async sendMessage(recipientId: string, message: string) {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v18.0/me/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: message }
          })
        }
      );

      return response;
    } catch (error) {
      console.error("Error enviando mensaje de Instagram:", error);
      throw error;
    }
  }
}

export default new InstagramService();
