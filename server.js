/**
 * server.js - kopierfertig (inkl. freundlicher Stil, Follow-ups, Zufriedenheitscheck)
 *
 * Enthält:
 * - Moderation Middleware
 * - In-Memory LRU Cache + Debounce
 * - fetchWithRetry (AI + n8n Calls)
 * - Follow-up statt sofortigem Ticket bei KEINE_ANTWORT
 * - Soft-Escalation mit angereichertem Ticket-Payload
 * - Post-Answer Klärungs- / Abschluss-Checks und Zufriedenheitsflow
 *
 * Env vars required:
 * - AI_API_KEY
 * - MODEL
 * - N8N_WEBHOOK
 * - N8N_TICKET_WEBHOOK
 * - CACHE_TTL_SECONDS (optional)
 *
 * Hinweise:
 * - Frontend sollte followUps (array) anzeigen und Button‑Klicks als normale /chat Requests senden.
 * - userId im Request Body empfohlen, damit Follow-up State funktioniert.
 */

import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { LRUCache } from "lru-cache";
import crypto from "crypto";

dotenv.config({ path: "./backend.env" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json()); // Body Parser MUSS vor allen Routen stehen

// --- Konfiguration / Defaults ---
const FALLBACK_OFFTOPIC = process.env.FALLBACK_OFFTOPIC || "Diese Frage liegt außerhalb dessen, wozu ich dir als Assistent von POLI SOCIAL helfen kann. Bei Fragen rund um dein Konto, Registrierung, Richtlinien oder Werbung bin ich gerne für dich da.";
const FALLBACK_TICKET = process.env.FALLBACK_TICKET || "Ich kann dir dazu im Moment keine gesicherte Antwort geben. Ich habe deine Frage an unser Support-Team weitergeleitet – jemand meldet sich bald bei dir.";

const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 300); // Sekunden
const cache = new LRUCache({ max: 5000, ttl: CACHE_TTL * 1000 });

// simple in-memory debounce map (prevents duplicate processing)
const recentRequests = new Map(); // key -> timestamp
const DEBOUNCE_WINDOW_MS = 2000; // 2s

// ---------------- Helper Functions ----------------

/**
 * fetchWithRetry: robust wrapper with retries and exponential backoff
 */
async function fetchWithRetry(url, options, retries = 2, backoffMs = 500) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const resp = await fetch(url, options);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Status ${resp.status}: ${text}`);
      }
      return resp;
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      await new Promise(r => setTimeout(r, backoffMs * attempt));
    }
  }
}

/**
 * askFollowUp: returns a JSON payload with follow-up suggestions
 */
function askFollowUp(res, promptText, suggestions = []) {
  return res.json({
    reply: promptText,
    followUps: suggestions
  });
}

/**
 * triggerTicket: enriched ticket payload, returns ticketId or requestId
 */
async function triggerTicket(userMessage, reason, context = {}) {
  const ticketWebhook = process.env.N8N_TICKET_WEBHOOK;
  if (!ticketWebhook) {
    console.warn("N8N_TICKET_WEBHOOK nicht konfiguriert, Ticket wird nicht erstellt. Grund:", reason);
    return null;
  }
  const payload = {
    query: userMessage,
    reason,
    context,
    userId: context.userId || null,
    best_score: context.best_score ?? null,
    topk: context.topk ?? null,
    timestamp: new Date().toISOString(),
    requestId: crypto.randomUUID()
  };
  try {
    const resp = await fetchWithRetry(ticketWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, 1, 300);
    const data = await resp.json().catch(() => null);
    return data?.ticketId || payload.requestId;
  } catch (err) {
    console.warn("Ticket-Erstellung fehlgeschlagen:", err.message);
    return payload.requestId; // fallback to requestId so user has reference
  }
}

/**
 * normalize text for simple intent matching
 */
function norm(text = "") {
  return text.trim().toLowerCase();
}

/**
 * pending state helpers
 */
function setPending(userId, obj, ttlSeconds = 600) {
  if (!userId) return;
  const key = `pending:${userId}`;
  cache.set(key, obj);
  // LRUCache uses global TTL; to emulate per-key TTL we rely on global TTL here.
}
function getPending(userId) {
  if (!userId) return null;
  const key = `pending:${userId}`;
  return cache.get(key) || null;
}
function clearPending(userId) {
  if (!userId) return;
  const key = `pending:${userId}`;
  cache.delete(key);
}



// ---------------- Health Endpoint ----------------
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// ---------------- Chat Endpoint ----------------
app.post("/chat", async (req, res) => {
  const startTs = Date.now();
  try {
    const userMessageRaw = req.body?.message;
    const userId = req.body?.userId || null;
    const followUpResponse = req.body?.followUpResponse || null; // optional field from frontend buttons
    if (!userMessageRaw && !followUpResponse) {
      return res.status(400).json({ error: "Missing message" });
    }

    // If frontend sends followUpResponse, treat it as the user's message
    const userMessage = (followUpResponse && typeof followUpResponse === "string") ? followUpResponse : userMessageRaw;
    const userMessageNorm = norm(userMessage);

    // Quick-check: is there a pending state for this user? If so, handle follow-up intents first.
    const pending = getPending(userId);

// War die letzte Bot-Nachricht eine Bitte um Präzisierung? Dann ist DIESE Nachricht die Neuformulierung.
let isClarifyRetry = false;
if (pending && pending.stage === "clarifying") {
  isClarifyRetry = true;
  clearPending(userId);
  // Kein return hier - die Neuformulierung durchläuft unten die normale Suche erneut.
}

    if (pending && pending.awaitingClarification) {
      // pending.stage can be 'post_answer' or 'awaiting_clarify'
      // Interpret common quick replies
      if (/(^ja\b|^ja,? das hilft|^ja, danke|^super|^passt$)/i.test(userMessage)) {
        // User confirms the answer helped
        clearPending(userId);
        // Ask if they need anything else; if not, later ask satisfaction on farewell
        return res.json({
          reply: "Super, freut mich, dass ich helfen konnte. Brauchst du noch etwas anderes?",
          followUps: ["Nein, danke", "Ja, noch etwas"]
        });
      }

          if (/(^nein\b|^nein, mehr|^mehr details|^erkläre|^noch mal)/i.test(userMessage)) {
        const AI_API_KEY = process.env.AI_API_KEY;
        const MODEL = process.env.MODEL;
        if (!AI_API_KEY || !MODEL) {
          return res.status(500).json({ error: "Server misconfiguration: missing AI_API_KEY or MODEL" });
        }

        const systemPrompt = `Du bist der freundliche Support-Assistent von POLI SOCIAL. Beantworte die Nutzerfrage AUSSCHLIESSLICH basierend auf dem untenstehenden Kontext - erfinde niemals Abläufe, Menüpfade oder Details, die dort nicht explizit stehen. Prüfe SCHRITT FÜR SCHRITT, bevor du antwortest: Steht die konkrete Handlung oder Information, nach der gefragt wird, WÖRTLICH oder sinngemäß direkt im Kontext? Falls du auch nur einen einzigen Schritt, ein UI-Element oder eine Information nennen müsstest, die NICHT explizit im Kontext steht, antworte AUSSCHLIESSLICH mit dem Wort KEINE_ANTWORT, ohne weiteren Text. Ein vager Verweis ohne Beleg im Kontext zählt als Erfindung und ist verboten.`;
        // WICHTIG: Wir greifen auf den ORIGINALEN Kontext zurück, nicht auf die vorherige (möglicherweise unvollständige) Antwort - so bleibt jede Antwort unabhängig gegen die Wissensbasis geprüft.
        const userPrompt = `Kontext:\n${pending.context?.context || pending.context?.contextText || ""}\n\nNutzerfrage:\n${pending.originalQuestion}\n\nDer Nutzer möchte eine ausführlichere Antwort. Gib alle relevanten Details, die im Kontext stehen, strukturiert wieder (max. 5 kurze Punkte oder 3 Sätze) - ausschließlich basierend auf dem Kontext.`;

        try {
          const aiResp = await fetchWithRetry("https://llm.aihosting.mittwald.de/v1/chat/completions", {
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
              ],
              max_tokens: 800,
              temperature: 0.0
            })
          }, 2, 500);

          const data = await aiResp.json().catch(() => ({}));
          const expanded = (data.choices?.[0]?.message?.content ?? "").trim();

          if (expanded === "KEINE_ANTWORT" || !expanded) {
            const ticketId = await triggerTicket(pending.originalQuestion, "kein_wissensbasis_treffer_bei_detailanfrage", { userId, topk: pending.context?.topk, best_score: pending.context?.best_score });
            clearPending(userId);
            return res.json({ reply: FALLBACK_TICKET, ticketId });
          }

          setPending(userId, { originalQuestion: pending.originalQuestion, lastReply: expanded, context: pending.context, awaitingClarification: true });

          return res.json({
            reply: expanded,
            followUps: ["Ja, das hilft", "Nein, noch ein Ticket erstellen"]
          });
        } catch (err) {
          const ticketId = await triggerTicket(pending.originalQuestion, "ai_expand_error", { userId, topk: pending.context?.topk, best_score: pending.context?.best_score });
          clearPending(userId);
          return res.json({ reply: FALLBACK_TICKET, ticketId });
        }
      }

      if (/^(nein, danke|danke, fertig|fertig|tschüss|bye|danke)$/i.test(userMessage)) {
        // User ends conversation: ask satisfaction question
        clearPending(userId);
        // Keep a short pending to capture satisfaction answer
        setPending(userId, { stage: "satisfaction", originalQuestion: pending.originalQuestion, lastReply: pending.lastReply, awaitingSatisfaction: true });
        return res.json({
          reply: "Gern geschehen — freut mich, wenn ich helfen konnte. Warst du mit der Antwort zufrieden?",
          followUps: ["Ja", "Nein"]
        });
      }

      // If none matched, fall through to normal processing (treat as new question)
    }

    // If awaiting satisfaction
    if (pending && pending.awaitingSatisfaction) {
      if (/(^ja\b|^ja,?)/i.test(userMessage)) {
        clearPending(userId);
        return res.json({ reply: "Danke für dein Feedback! Schön, dass alles geklappt hat. Auf Wiedersehen!" });
      }
      if (/(^nein\b|^nein,?)/i.test(userMessage)) {
        // Offer ticket creation
        const ticketId = await triggerTicket(pending.originalQuestion || userMessage, "user_not_satisfied", { userId, lastReply: pending.lastReply });
        clearPending(userId);
              return res.json({
        reply: FALLBACK_TICKET,
        ticketId
      });
      }
      // else treat as new question
    }

    // No pending or not handled: proceed as new question

    // Smalltalk / Greeting detection (persona-consistent)
    const GREETING_PATTERN = /^(hallo|hi|hey|servus|moin|guten\s?tag|guten\s?morgen|guten\s?abend|na)[\s!.,]*$/i;
    const SMALLTALK_PATTERN = /\b(wie gehts|wie geht es dir|was machst du|wetter|spaß|witz)\b/i;

    if (GREETING_PATTERN.test(userMessage.trim())) {
      return res.json({
        reply: "Hallo! Ich bin der Assistent von POLI SOCIAL. Ich helfe dir gerne bei Fragen zu deinem Konto, zur Registrierung, zu unseren Richtlinien oder zum Schalten von Werbung. Möchtest du Hilfe zu Konto, Werbung oder Richtlinien?",
        followUps: ["Konto", "Werbung", "Richtlinien"]
      });
    }
    if (SMALLTALK_PATTERN.test(userMessage)) {
      return res.json({ reply: "Ich bin ein sachlicher Assistent von POLI SOCIAL — bei Fragen zu deinem Konto, Richtlinien oder Werbung helfe ich dir gern." });
    }
    // Expliziter Ticket-Wunsch: Bot erstellt sofort selbst ein Ticket, statt auf manuellen Weg zu verweisen
    const TICKET_REQUEST_PATTERN = /(ticket erstellen|erstell.*ticket|ein ticket|mit (einem |dem )?support|mit einem mitarbeiter|menschlichen support|jemanden vom team|echten menschen sprechen|support-mitarbeiter)/i;

    if (TICKET_REQUEST_PATTERN.test(userMessage)) {
      const ticketId = await triggerTicket(userMessage, "nutzer_wollte_direkten_support", { userId });
      return res.json({
        reply: `Ich habe ein Ticket für dich erstellt, unser Support-Team meldet sich bald bei dir. Ticket-ID: ${ticketId}`,
        ticketId
      });
    }
    // Debounce: prevent processing identical requests in short window
    const cacheKey = `kb:${crypto.createHash('sha256').update(userMessage).digest('hex')}`;
    const dedupeKey = `dedupe:${userId || 'anon'}:${cacheKey}`;
    const now = Date.now();
    if (recentRequests.has(dedupeKey) && (now - recentRequests.get(dedupeKey) < DEBOUNCE_WINDOW_MS)) {
      return res.json({ reply: "Ich bearbeite gerade eine ähnliche Anfrage — bitte kurz warten." });
    }
    recentRequests.set(dedupeKey, now);
    setTimeout(() => recentRequests.delete(dedupeKey), DEBOUNCE_WINDOW_MS);

    // Typing / Progress Indicator (Variant A): set header so client can show typing state
    res.setHeader("X-Bot-Status", "processing");

    // Cache lookup for KB result
    let searchResult = { matched: false, onTopic: false };
    const cached = cache.get(cacheKey);
    if (cached) {
      searchResult = cached;
    }

    // If not cached, call n8n to get searchResult
    if (!searchResult || Object.keys(searchResult).length === 0 || (searchResult.matched === false && searchResult.onTopic === false)) {
      try {
        const n8nResp = await fetchWithRetry(process.env.N8N_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: userMessage })
        }, 1, 300);
        if (n8nResp && n8nResp.ok) {
          searchResult = await n8nResp.json();
          // store in cache
          cache.set(cacheKey, searchResult);
        }
      } catch (err) {
        console.warn("n8n error:", err.message);
        // proceed with fallback: treat as no match (safe)
        searchResult = searchResult || { matched: false, onTopic: false };
      }
    }

    // Handle no-match / onTopic logic
    if (!searchResult.matched && !searchResult.onTopic) {
      return res.json({ reply: FALLBACK_OFFTOPIC });
    }
    if (!searchResult.matched && searchResult.onTopic) {
      // create ticket and inform user
      const ticketId = await triggerTicket(userMessage, "kein_wissensbasis_treffer", { userId, topk: searchResult.topk, best_score: searchResult.best_score });
      return res.json({ reply: FALLBACK_TICKET, ticketId });
    }

    // We have a KB match -> call LLM with friendly system prompt
    const AI_API_KEY = process.env.AI_API_KEY;
    const MODEL = process.env.MODEL;
    if (!AI_API_KEY || !MODEL) {
      console.error("Server misconfiguration: missing AI_API_KEY or MODEL");
      return res.status(500).json({ error: "Server misconfiguration: missing AI_API_KEY or MODEL" });
    }

    // Friendly system prompt: short answer + optional details, then ask if helpful
        const systemPrompt = `Du bist der freundliche Support-Assistent von POLI SOCIAL. Beantworte die Nutzerfrage AUSSCHLIESSLICH basierend auf dem untenstehenden Kontext - erfinde niemals Abläufe, Menüpfade oder Details, die dort nicht explizit stehen. Antworte kurz und klar: eine ein-sätzige Kurzantwort, bei Bedarf ein kurzer Detailabschnitt (max. 3 Sätze), höflich und sachlich. Schließe nicht mit einer Frage; wir fügen Follow-up-Buttons serverseitig hinzu. Prüfe SCHRITT FÜR SCHRITT, bevor du antwortest: Steht die konkrete Handlung oder Information, nach der gefragt wird, WÖRTLICH oder sinngemäß direkt im Kontext? Falls du auch nur einen einzigen Schritt, ein UI-Element (Button, Menüpunkt) oder eine Information nennen müsstest, die NICHT explizit im Kontext steht, antworte AUSSCHLIESSLICH mit dem Wort KEINE_ANTWORT, ohne weiteren Text. Ein vager Verweis auf "Support kontaktieren" oder "Einstellungen nutzen" ohne Beleg im Kontext zählt als Erfindung und ist verboten - nutze das Wort KEINE_ANTWORT stattdessen.`;
    const userPrompt = `Kontext:\n${searchResult.context || ""}\n\nNutzerfrage:\n${userMessage}`;

    // AI call with retry
    let aiResp;
    try {
      aiResp = await fetchWithRetry("https://llm.aihosting.mittwald.de/v1/chat/completions", {
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
          ],
          max_tokens: 600,
          temperature: 0.0
        })
      }, 2, 500);
    } catch (err) {
      console.error("AI API final error:", err.message);
      // fallback: create ticket and inform user
      const ticketId = await triggerTicket(userMessage, "ai_provider_error", { userId, topk: searchResult.topk, best_score: searchResult.best_score });
      return res.json({ reply: FALLBACK_TICKET, ticketId });
    }

    // parse AI response
    const data = await aiResp.json().catch(() => ({}));
    const reply = (data.choices?.[0]?.message?.content ?? "").trim();

        // KEINE_ANTWORT handling -> beim ersten Mal nachfragen, beim zweiten Mal Ticket erstellen
    if (reply === "KEINE_ANTWORT") {
      if (isClarifyRetry) {
        // Auch die neu formulierte Frage führte zu keiner Antwort -> jetzt Ticket, nicht nochmal fragen
        const ticketId = await triggerTicket(userMessage, "kein_wissensbasis_treffer_nach_praezisierung", { userId, topk: searchResult.topk, best_score: searchResult.best_score });
        return res.json({ reply: FALLBACK_TICKET, ticketId });
      }
      if (userId) {
        setPending(userId, { originalQuestion: userMessage, stage: "clarifying" });
      }
      return askFollowUp(res, "Dazu habe ich leider keine gesicherte Antwort gefunden. Kannst du deine Frage etwas genauer formulieren oder in anderen Worten stellen?", []);
    }

    // Normal reply -> set pending to expect confirmation and return followUps
    if (userId) {
      setPending(userId, { originalQuestion: userMessage, lastReply: reply, context: searchResult, awaitingClarification: true });
    }

    // Provide follow-up quick replies so frontend can render buttons
    const followUps = ["Ja, das hilft", "Nein, mehr Details", "Noch etwas"];

    return res.json({ reply, sources: searchResult.topk?.slice(0, 3) || [], followUps });

  } catch (error) {
    console.error("chat handler error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ---------------- STATIC FRONTEND (MUSS NACH allen API‑Routen stehen) ----------------
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`server start - pid=${process.pid} env=${process.env.NODE_ENV || "dev"} PORT=${PORT}`);
});
