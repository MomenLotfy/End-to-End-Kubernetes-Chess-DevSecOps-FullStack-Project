import { useSettings } from "../contexts/SettingsContext";

// ============================================================
// components/GameStatusBar.js — حالة اللعبة + تاريخ الحركات + شريط أدوات أيقونات
// ============================================================
export default function GameStatusBar({ status, turn, hist, onNewGame, onUndo, canUndo, onShare, onHint, hintDisabled, opening }) {
  const { colors: C } = useSettings();

  const toolBtn = (label, icon, onClick, disabled, glow) => (
    <div onClick={disabled ? undefined : onClick} className={`cm-btn ${glow ? "cm-gold-pulse" : ""}`}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.35 : 1, padding: "8px 14px", borderRadius: "var(--r-md)",
        border: glow ? `1px solid ${C.gold}` : "1px solid transparent",
      }}>
      <span style={{ fontSize: "1.25rem", color: glow ? C.gold : C.txMut }}>{icon}</span>
      <span style={{ fontSize: "var(--fs-caption)", fontWeight: 700, letterSpacing: "0.08em", color: glow ? C.gold : C.txMut, textTransform: "uppercase" }}>{label}</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", width: "100%", maxWidth: "510px" }}>
      {opening && (
        <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.04em" }}>📖 {opening.name}</div>
      )}

      {status === "checkmate" && (
        <div className="cm-banner" style={{ width: "100%", textAlign: "center", background: `linear-gradient(180deg, ${C.accentHv}, ${C.accent})`, color: "#fff8ec", padding: "12px 24px", borderRadius: "var(--r-md)", fontWeight: 700, fontSize: "var(--fs-small)", letterSpacing: "0.08em", border: `1px solid ${C.gold}`, boxShadow: "var(--sh-md)" }}>
          {turn === "w" ? "BLACK WINS — CHECKMATE!" : "WHITE WINS — CHECKMATE!"}
        </div>
      )}
      {status === "stalemate" && (
        <div className="cm-banner" style={{ width: "100%", textAlign: "center", background: C.surface, color: C.tx, padding: "12px 24px", borderRadius: "var(--r-md)", fontWeight: 700, fontSize: "var(--fs-small)", letterSpacing: "0.08em", border: `1px solid ${C.border}` }}>⚖ STALEMATE — DRAW</div>
      )}
      {status === "timeout" && (
        <div className="cm-banner" style={{ width: "100%", textAlign: "center", background: C.surface, color: C.tx, padding: "12px 24px", borderRadius: "var(--r-md)", fontWeight: 700, fontSize: "var(--fs-small)", letterSpacing: "0.08em", border: `1px solid ${C.border}` }}>
          ⏱ {turn === "w" ? "WHITE" : "BLACK"} RAN OUT OF TIME — {turn === "w" ? "BLACK" : "WHITE"} WINS!
        </div>
      )}
      {status === "check" && (
        <div className="cm-banner" style={{ width: "100%", textAlign: "center", background: C.danger, color: "#fff", padding: "11px 20px", borderRadius: "var(--r-md)", fontWeight: 700, fontSize: "var(--fs-small)", letterSpacing: "0.1em", boxShadow: `0 0 20px ${C.danger}66` }}>CHECK!</div>
      )}
      {(!status || status === "check") && (
        <div className="cm-banner" style={{ background: turn === "w" ? C.surface : C.woodDk, color: C.tx, padding: "9px 26px", borderRadius: "var(--r-full)", fontWeight: 700, fontSize: "var(--fs-small)", letterSpacing: "0.12em", border: `1px solid ${C.border}` }}>
          {turn === "w" ? "WHITE'S TURN" : "BLACK'S TURN"}
        </div>
      )}

      {hist.length > 0 && (
        <div style={{ maxHeight: "68px", overflowY: "auto", padding: "6px 10px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-sm)", width: "100%", display: "flex", flexWrap: "wrap", gap: "2px 8px", fontSize: "var(--fs-caption)" }}>
          {hist.map((m, i) => <span key={i} style={{ color: i % 2 === 0 ? C.tx : C.txMut }}>{i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}{m}</span>)}
        </div>
      )}

      <div style={{ display: "flex", gap: "4px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-lg)", padding: "4px" }}>
        {onHint && toolBtn("Hint", "💡", onHint, hintDisabled, false)}
        {toolBtn("Undo", "↶", onUndo, !canUndo, false)}
        {onShare && toolBtn("Share", "⤴", onShare, false, false)}
        {toolBtn("New Game", "♜", onNewGame, false, true)}
      </div>
    </div>
  );
}
