import React, { useState, useEffect, useRef } from "react";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function Chat() {
  const [showDisclosure, setShowDisclosure] = useState(true);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState(false);
  const [ticketId, setTicketId] = useState(null);
  const [sending, setSending] = useState(false);
  const messagesRef = useRef(null);

  useEffect(() => {
    let uid = localStorage.getItem("ps_userId");
    if (!uid) {
      uid = `anon-${Math.random().toString(36).slice(2, 9)}`;
      localStorage.setItem("ps_userId", uid);
    }
  }, []);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const lastSent = useRef({ hash: null, ts: 0 });
  const CLIENT_DEBOUNCE_MS = 1500;
  const lastActivityTs = useRef(Date.now());
  const INACTIVITY_THRESHOLD_MS = 4 * 60 * 1000; // etwas unter der 5-Minuten-Serverspeicherung

  function appendMessage(text, from = "bot") {
    setMessages(prev => [...prev, { from, text }]);
  }

  function showTicket(id) {
    setTicketId(id || null);
  }

  async function doSend(payload) {
    const uid = localStorage.getItem("ps_userId");
    const now = Date.now();
    const hash = `${payload.message || ""}`;
    if (hash === lastSent.current.hash && (now - lastSent.current.ts) < CLIENT_DEBOUNCE_MS) {
      appendMessage("Bitte kurz warten ‚Äî ich bearbeite bereits eine √§hnliche Anfrage.", "bot");
      return;
    }
    lastSent.current = { hash, ts: now };

    if (messages.length > 0 && (now - lastActivityTs.current) > INACTIVITY_THRESHOLD_MS) {
         appendMessage("Es ist etwas Zeit vergangen - falls ich den Faden verloren habe, formuliere deine Frage gerne noch einmal vollständig.", "bot");
    }
    lastActivityTs.current = now;

    if (payload.message) appendMessage(payload.message, "user");

    setShowDisclosure(false);
    setSending(true);
    setTyping(true);
    showTicket(null);

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.message || null,
          userId: uid
        })
      });

      const botStatus = res.headers.get("X-Bot-Status");
      if (botStatus && botStatus.toLowerCase() === "processing") {
        setTyping(true);
      }

      const data = await res.json();

      setTyping(false);
      setSending(false);

      if (data.ticketId) {
        showTicket(data.ticketId);
      }

      if (data.reply) {
        appendMessage(data.reply, "bot");
      }

      if (data.sources && Array.isArray(data.sources) && data.sources.length) {
        appendMessage("Quellen: " + data.sources.map(s => s.title || s.id || "").filter(Boolean).join(", "), "bot");
      }

    } catch (err) {
      setTyping(false);
      setSending(false);
      appendMessage("Fehler beim Senden. Bitte versuche es erneut.", "bot");
      console.error("chat error", err);
    }
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    doSend({ message: text });
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-container" style={{ maxWidth: 720, margin: "0 auto", fontFamily: "Arial, sans-serif" }}>
         <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
        {showDisclosure && (
          <div className="ai-disclosure" style={{ padding: "8px 12px", background: "#f1f3f5", fontSize: 13, color: "#555", borderBottom: "1px solid #eee" }}>
            Hinweis: Du sprichst hier mit einem KI-gestützten Assistenten, keiner echten Person. Bei komplexeren Anliegen leiten wir dich an unser Support-Team weiter.
          </div>
        )}
        <div ref={messagesRef} className="messages" style={{ minHeight: 300, maxHeight: 500, overflowY: "auto", padding: 12 }}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.from}`} style={{ margin: "8px 0", textAlign: m.from === "user" ? "right" : "left" }}>
                        <div style={{ display: "inline-block", padding: "8px 12px", borderRadius: 12, background: m.from === "user" ? "#0b74de" : "#f1f3f5", color: m.from === "user" ? "#fff" : "#000", maxWidth: "80%", whiteSpace: "pre-wrap" }}>
              {m.text}
            </div>
          </div>
                ))}
        </div>
      </div>

      <div className="meta" style={{ marginTop: 8 }}>
        {typing && <div className="typing" style={{ color: "#666", marginBottom: 8 }}>Der Assistent tippt‚Ä¶</div>}
        {ticketId && (
          <div className="ticket" style={{ marginBottom: 8 }}>
            Ticket: <strong>{ticketId}</strong>
            <button style={{ marginLeft: 8 }} onClick={() => { navigator.clipboard?.writeText(ticketId); }}>Kopieren</button>
          </div>
        )}
      </div>

      <div className="composer" style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Schreibe eine Nachricht..."
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ddd", minHeight: 40 }}
        />
        <button onClick={handleSend} disabled={sending} style={{ padding: "8px 14px", borderRadius: 8, background: "#0b74de", color: "#fff", border: "none", cursor: "pointer" }}>
          Senden
        </button>
      </div>
    </div>
  );
}
