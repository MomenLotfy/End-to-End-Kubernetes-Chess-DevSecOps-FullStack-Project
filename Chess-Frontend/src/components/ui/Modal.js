// src/components/ui/Modal.js
import { useSettings } from "../../contexts/SettingsContext";
import Icon from "./Icon";

// ============================================================
// components/ui/Modal.js — إطار موحّد لكل الـ modals
// backdrop بيفيد‑إن، الكارت نفسه بيعمل pop (scale+fade)
// ============================================================
export default function Modal({ children, onClose, width = 380, ornate = false, tone = "elevated" }) {
  const { colors: C } = useSettings();

  const bg = tone === "parchment" ? C.modalBg : C.modalBg;

  return (
    <div
      className="cm-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.78)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "14px" }}
    >
      <div
        className="cm-modal-pop"
        style={{
          background: bg,
          border: `1px solid ${C.border}`,
          borderRadius: "var(--r-lg)",
          padding: "26px",
          width,
          maxWidth: "94vw",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: `var(--sh-lg), 0 0 0 1px ${C.goldSoft}`,
          position: "relative",
        }}
      >
        {ornate && <OrnateCorners C={C} />}
        {children}
      </div>
    </div>
  );
}

// زوايا مزخرفة زي نافذة الإعدادات (تفصيلة بصرية بسيطة بـ CSS/SVG)
function OrnateCorners({ C }) {
  const corner = (pos) => ({
    position: "absolute", width: "22px", height: "22px", pointerEvents: "none",
    border: `2px solid ${C.gold}`, opacity: 0.55,
    ...pos,
  });
  return (
    <>
      <div style={{ ...corner({ top: 8, left: 8, borderRight: "none", borderBottom: "none" }) }} />
      <div style={{ ...corner({ top: 8, right: 8, borderLeft: "none", borderBottom: "none" }) }} />
      <div style={{ ...corner({ bottom: 8, left: 8, borderRight: "none", borderTop: "none" }) }} />
      <div style={{ ...corner({ bottom: 8, right: 8, borderLeft: "none", borderTop: "none" }) }} />
    </>
  );
}

export function ModalHeader({ title, subtitle, onClose }) {
  const { colors: C } = useSettings();
  return (
    <div style={{ marginBottom: "var(--sp-4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.tx, letterSpacing: "0.02em" }}>{title}</h2>
        {onClose && (
          <button onClick={onClose} className="cm-btn" style={{ background: "transparent", border: "none", color: C.txMut, fontSize: "1.3rem", cursor: "pointer", lineHeight: 1, padding: "2px 6px" }}>
            <Icon name="back" size={24} />
          </button>
        )}
      </div>
      {subtitle && <div style={{ fontSize: "var(--fs-small)", color: C.txMut, marginTop: "4px" }}>{subtitle}</div>}
    </div>
  );
}

// نقطة الديكور المتلألئة المتكررة في الصور (sparkle) — عنصر علامة تجارية بسيط
export function Sparkle({ style }) {
  const { colors: C } = useSettings();
  return (
    <svg className="cm-sparkle" width="28" height="28" viewBox="0 0 24 24" style={{ position: "fixed", pointerEvents: "none", opacity: 0.35, ...style }}>
      <path d="M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z" fill={C.gold} />
    </svg>
  );
}
