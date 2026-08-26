import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({ path: "./backend.env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json()); // Body Parser MUSS vor allen Routen stehen
const FALLBACK_OFFTOPIC = "Diese Frage liegt außerhalb dessen, wozu ich dir als Assistent von POLI SOCIAL helfen kann. Bei Fragen rund um dein Konto, Registrierung, Richtlinien oder Werbung bin ich gerne für dich da.";
const FALLBACK_TICKET = "Ich kann dir dazu im Moment keine gesicherte Antwort geben. Ich habe deine Frage an unser Support-Team weitergeleitet – jemand meldet sich bald bei dir.";

// HEALTH ENDPOINT (früh definieren)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// CHAT ENDPOINT (MUSS VOR static stehen!)
function triggerTicket(userMessage, reason) {
  const ticketWebhook = process.env.N8N_TICKET_WEBHOOK;
  if (!ticketWebhook) {
    console.warn("N8N_TICKET_WEBHOOK nicht konfiguriert, Ticket wird nicht erstellt. Grund:", reason);
    return;
  }
  // Fire-and-forget: blockiert nicht die Antwort an den Nutzer
  fetch(ticketWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: userMessage, reason })
  }).catch(err => console.warn("Ticket-Erstellung fehlgeschlagen:", err.message));
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body?.message;
    if (!userMessage) {
      return res.status(400).json({ error: "Missing message" });
    }
const GREETING_PATTERN = /^(hallo|hi|hey|servus|moin|guten\s?tag|guten\s?morgen|guten\s?abend|na)[\s!.,]*$/i;

if (GREETING_PATTERN.test(userMessage.trim())) {
  return res.json({
    reply: "Hallo! Ich bin der Assistent von POLI SOCIAL. Ich helfe dir gerne bei Fragen zu deinem Konto, zur Registrierung, zu unseren Richtlinien oder zum Schalten von Werbung. Was möchtest du wissen?"
  });
}
    const AI_API_KEY = process.env.AI_API_KEY;
    const MODEL = process.env.MODEL;
    const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

    if (!AI_API_KEY || !MODEL || !N8N_WEBHOOK) {
      return res.status(500).json({ error: "Server misconfiguration: missing AI_API_KEY, MODEL or N8N_WEBHOOK" });
    }

    // n8n: Wissensbasis-Suche + Themen-Klassifizierung
    let searchResult = { matched: false, onTopic: false };
    try {
      const n8nResp = await fetch(N8N_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: userMessage })
      });
      if (n8nResp.ok) {
        searchResult = await n8nResp.json();
      }
    } catch (err) {
      console.warn("n8n error:", err.message);
    }

    // Fall 1: kein Treffer, themenfremd -> keine KI, kein Ticket
    if (!searchResult.matched && !searchResult.onTopic) {
      return res.json({ reply: FALLBACK_OFFTOPIC });
    }

    // Fall 2: kein Treffer, aber themenbezogen -> keine KI, Ticket
    if (!searchResult.matched && searchResult.onTopic) {
      triggerTicket(userMessage, "kein_wissensbasis_treffer");
      return res.json({ reply: FALLBACK_TICKET });
    }

    // Fall 3: Treffer vorhanden -> KI antworten lassen, mit Sicherheitsnetz
    const systemPrompt = `Du bist der Support-Assistent von POLI SOCIAL. Du bekommst einen Kontext aus der offiziellen Wissensbasis (Richtlinien und FAQ). Beantworte die Nutzerfrage ausschließlich basierend auf diesem Kontext, in eigenen, verständlichen Worten - gib niemals den Kontext wortwörtlich zurück. Falls der Kontext die Frage nicht wirklich beantwortet, antworte AUSSCHLIESSLICH mit dem Wort KEINE_ANTWORT, ohne weiteren Text.`;

    const userPrompt = `Kontext:\n${searchResult.context}\n\nNutzerfrage:\n${userMessage}`;

    const aiResp = await fetch("https://llm.aihosting.mittwald.de/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": AI_API_KEY
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!aiResp.ok) {
      const text = await aiResp.text();
      console.error("AI API error:", aiResp.status, text);
      return res.status(502).json({ error: "AI provider error" });
    }

    const data = await aiResp.json();
    const reply = (data.choices?.[0]?.message?.content ?? "").trim();

    if (reply === "KEINE_ANTWORT") {
      triggerTicket(userMessage, "ki_konnte_kontext_nicht_nutzen");
      return res.json({ reply: FALLBACK_TICKET });
    }

    res.json({ reply });
  } catch (error) {
    console.error("chat handler error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// STATIC FRONTEND (MUSS NACH allen API‑Routen stehen)
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`server start - pid=${process.pid} env=${process.env.NODE_ENV || "dev"} PORT=${PORT}`);
});
