// FILE: server.js
import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static frontend from ./public
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

// Health endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage) return res.status(400).json({ error: "Missing message" });

    const response = await fetch("https://api.ai.mittwald.de/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.AI_API_KEY
      },
      body: JSON.stringify({
        model: process.env.MODEL,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
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
    res.json({ reply });
  } catch (error) {
    console.error("chat handler error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start server on 0.0.0.0:8080
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`server start - pid=${process.pid} env=${process.env.NODE_ENV || "dev"} PORT=${PORT}`);
});


