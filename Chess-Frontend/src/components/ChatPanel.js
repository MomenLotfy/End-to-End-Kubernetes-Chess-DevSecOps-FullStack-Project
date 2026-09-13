import { useState, useRef, useEffect } from "react";
import { useSettings } from "../contexts/SettingsContext";

// ============================================================
// components/ChatPanel.js — شات داخل اللعبة (Game Chat)
// ============================================================
export default function ChatPanel({ messages, onSend, disabled, compact = false }) {
  const { colors: C } = useSettings();
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const clean = text.trim();
    if (!clean || disabled) return;
    onSend(clean);
    setText("");
  };

  return (
    <div style={{
      width: "100%", maxWidth: compact ? "510px" : "280px", background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: "var(--r-lg)", display: "flex", flexDirection: "column", boxShadow: "var(--sh-md)",
      height: compact ? "auto" : "100%",
    }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--fs-h2)", color: C.gold, letterSpacing: "0.04em" }}>Game Chat</div>

      <div ref={listRef} style={{ flex: 1, minHeight: compact ? "70px" : "220px", maxHeight: compact ? "90px" : "340px", overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {messages.length === 0
          ? <div style={{ color: C.txFaint, fontSize: "var(--fs-caption)", fontStyle: "italic" }}>No messages yet — say hi 👋</div>
          : messages.map((m, i) => (
              <div key={i} className="cm-fade-in">
                <div style={{ fontSize: "var(--fs-caption)", color: C.txMut }}>
                  <span style={{ fontWeight: 700, color: m.color === "w" ? C.gold : C.tx }}>{m.playerName}</span>
                </div>
                <div style={{ fontSize: "var(--fs-small)", color: C.tx }}>{m.text}</div>
              </div>
            ))}
      </div>

      <div style={{ display: "flex", gap: "8px", padding: "12px 16px", borderTop: `1px solid ${C.border}` }}>
        <input
          value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
          placeholder="Type a message..." maxLength={200} disabled={disabled}
          style={{ flex: 1, padding: "9px 12px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", color: C.tx, fontSize: "var(--fs-small)", fontFamily: "var(--font-ui)", outline: "none" }}
        />
        <button onClick={send} disabled={disabled} className="cm-btn" style={{ background: `linear-gradient(180deg, ${C.accentHv}, ${C.accent})`, color: "#fff8ec", border: "none", padding: "9px 16px", borderRadius: "var(--r-md)", cursor: "pointer", fontSize: "var(--fs-caption)", fontWeight: 700, letterSpacing: "0.06em" }}>Send</button>
      </div>
    </div>
  );
}
