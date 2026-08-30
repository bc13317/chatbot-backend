import React, { useState, useEffect, useRef } from "react";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [quickReplies, setQuickReplies] = useState([]);
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
  }, [messages, quickReplies]);

  const lastSent = useRef({ hash: null, ts: 0 });
  const CLIENT_DEBOUNCE_MS = 1500;

  function appendMessage(text, from = "bot") {
    setMessages(prev => [...prev, { from, text }]);
  }

  function clearQuickReplies() {
    setQuickReplies([]);
  }

  function showTicket(id) {
    setTicketId(id || null);
  }

  async function doSend(payload) {
    const uid = localStorage.getItem("ps_userId");
    const now = Date.now();
    const hash = `${payload.message || ""}:${payload.followUpResponse || ""}`;
    if (hash === lastSent.current.hash && (now - lastSent.current.ts) < CLIENT_DEBOUNCE_MS) {
      appendMessage("Bitte kurz warten — ich bearbeite bereits eine ähnliche Anfrage.", "bot");
      return;
    }
    lastSent.current = { hash, ts: now };

    if (payload.message) appendMessage(payload.message, "user");

    setSending(true);
    setTyping(true);
    clearQuickReplies();
    showTicket(null);

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.message || null,
          followUpResponse: payload.followUpResponse || null,
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

      if (data.followUps && Array.isArray(data.followUps) && data.followUps.length) {
        setQuickReplies(data.followUps);
      } else {
        setQuickReplies([]);
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

  function handleQuickReply(text) {
    doSend({ message: text, followUpResponse: text });
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-container" style={{ maxWidth: 720, margin: "0 auto", fontFamily: "Arial, sans-serif" }}>
      <div ref={messagesRef} className="messages" style={{ minHeight: 300, maxHeight: 500, overflowY: "auto", padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.from}`} style={{ margin: "8px 0", textAlign: m.from === "user" ? "right" : "left" }}>
            <div style={{ display: "inline-block", padding: "8px 12px", borderRadius: 12, background: m.from === "user" ? "#0b74de" : "#f1f3f5", color: m.from === "user" ? "#fff" : "#000", maxWidth: "80%" }}>
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <div className="meta" style={{ marginTop: 8 }}>
        {typing && <div className="typing" style={{ color: "#666", marginBottom: 8 }}>Der Assistent tippt…</div>}
        {ticketId && (
          <div className="ticket" style={{ marginBottom: 8 }}>
            Ticket: <strong>{ticketId}</strong>
            <button style={{ marginLeft: 8 }} onClick={() => { navigator.clipboard?.writeText(ticketId); }}>Kopieren</button>
          </div>
        )}
        {quickReplies.length > 0 && (
          <div className="quick-replies" style={{ marginBottom: 8 }}>
            {quickReplies.map((q, idx) => (
              <button key={idx} onClick={() => handleQuickReply(q)} style={{ marginRight: 8, marginBottom: 6, padding: "6px 10px", borderRadius: 20, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
                {q}
              </button>
            ))}
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
