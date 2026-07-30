import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// STATIC FRONTEND
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

// HEALTH
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// CHAT ENDPOINT
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage) {
      return res.status(400).json({ error: "Missing message" });
    }

    // required env checks
    const AI_API_KEY = process.env.AI_API_KEY;
    const MODEL = process.env.MODEL;
    const N8N_WEBHOOK = process.env.N8N_WEBHOOK;          // z.B. https://p-ak2q3k.project.space/webhook-test/polischat-search
    const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN || ""; // optional, falls im Webhook genutzt

    if (!AI_API_KEY || !MODEL) {
      return res.status(500).json({ error: "Server misconfiguration: missing AI_API_KEY or MODEL" });
    }

    // 1) Echtzeit-Daten von n8n holen (falls konfiguriert)
    let realtimeData = null;
    if (N8N_WEBHOOK) {
      try {
        const n8nResp = await fetch(N8N_WEBHOOK, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(N8N_TOKEN ? { "x-webhook-token": N8N_TOKEN } : {})
          },
          body: JSON.stringify({ query: userMessage })
        });

        if (n8nResp.ok) {
          realtimeData = await n8nResp.json();
        } else {
          const txt = await n8nResp.text();
          console.warn("n8n error:", n8nResp.status, txt);
        }
      } catch (err) {
        console.warn("Failed to call n8n webhook:", err.message);
      }
    }

    // 2) Prompt für AI bauen – mit Echtzeitdaten, falls vorhanden
    const contextFromN8n = realtimeData
      ? `Echtzeitdaten:\n${JSON.stringify(realtimeData, null, 2)}\n\n`
      : "";

    const prompt = `
Nutzerfrage:
${userMessage}

${contextFromN8n}
Nutze die oben stehenden Echtzeitdaten, falls sie relevant sind, und antworte präzise und verständlich auf Deutsch.
`;

    // 3) Call AI provider
    const aiResp = await fetch("https://api.ai.mittwald.de/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": AI_API_KEY
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!aiResp.ok) {
      const text = await aiResp.text();
      console.error("AI API error:", aiResp.status, text);
      return res.status(502).json({ error: "AI provider error" });
    }

    const data = await aiResp.json();
    const reply = data.choices?.[0]?.message?.content ?? "";

    // 4) Antwort zurück an Frontend
    res.json({ reply });
  } catch (error) {
    console.error("chat handler error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// START SERVER
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`server start - pid=${process.pid} env=${process.env.NODE_ENV || "dev"} PORT=${PORT}`);
});
