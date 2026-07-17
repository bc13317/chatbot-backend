import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

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
      })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "";

    res.json({ reply });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// AI‑Hosting verlangt zwingend Port 8080
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`server start - pid=${process.pid} env=${process.env.NODE_ENV || 'dev'} PORT=${PORT}`);
});

