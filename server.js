// FILE: server.js
import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// STATIC FRONTEND
// -----------------------------------------------------------------------------
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

// -----------------------------------------------------------------------------
// HEALTH ENDPOINT
// -----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// n8n WEBHOOK CALL
// -----------------------------------------------------------------------------
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;        // https://p-ak2q3k.project.space/
const N8N_WEBHOOK_TOKEN = process.env.N8N_WEBHOOK_TOKEN;    // JJ12m3B@45!JJ12m3B@45!!

async function fetchWebFacts(query) {
  try {
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-token": N8N_WEBHOOK_TOKEN
      },
      body: JSON.stringify({ query }),
      timeout: 15000
    });

    if (!res.ok) {
      console.warn("n8n webhook error:", res.status);
      return [];
    }

    const json = await res.json();
    return json.hits || [];
  } catch (err) {
    console.warn("n8n fetch failed:", err.message);
    return [];
  }
}

// -----------------------------------------------------------------------------
// CHAT ENDPOINT (LLM + n8n Web-Fakten)
// -----------------------------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage) return res.status(400).json({ error: "Missing message" });

    // 1) Fetch current web facts from n8n
    const hits = await fetchWebFacts(userMessage);

    const contextText = hits.length
      ? "Aktuelle Web-Fakten:\n" + hits.map(h =>
          `${h.title} — ${h.url} (${h.publishedAt || "n.d."})`
        ).join("\n")
      : "Keine aktuellen Web-Fakten verfügbar.";

    // 2) LLM call with context
    const response = await fetch("https://api.ai.mittwald.de/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.AI_API_KEY
      },
      body: JSON.stringify({
        model: process.env.MODEL,
        messages: [
          { role: "system", content: contextText },
          { role: "user", content: userMessage }
        ]
      }),
      timeout: 30000
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("LLM API error:", response.status, text);
      return res.status(502).json({ error: "Upstream API error", status: response.status });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "";

    // 3) Return reply + sources to frontend
    res.json({ reply, sources: hits });

  } catch (error) {
    console.error("chat handler error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`server start - pid=${process.pid} env=${process.env.NODE_ENV || "dev"} PORT=${PORT}`);
});
