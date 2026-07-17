import React, { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';

export default function Chat() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);

  async function send() {
    if (!input.trim()) return;
    const text = input;
    setMessages(prev => [...prev, { from: 'user', text }]);
    setInput('');
    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      const data = await res.json();
      setMessages(prev => [...prev, { from: 'bot', text: data.reply || JSON.stringify(data) }]);
    } catch (err) {
      setMessages(prev => [...prev, { from: 'bot', text: 'Fehler: ' + err.message }]);
    }
  }

  return (
    <div className="chat">
      <div className="messages">
        {messages.map((m, i) => <div key={i} className={`msg ${m.from}`}>{m.text}</div>)}
      </div>
      <div className="input">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} />
        <button onClick={send}>Senden</button>
      </div>
    </div>
  );
}
