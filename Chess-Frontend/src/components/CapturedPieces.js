import { useSettings } from "../contexts/SettingsContext";
import PieceGlyph from "./ui/PieceGlyph";

// ============================================================
// components/CapturedPieces.js — صف القطع المأكولة (أبيض/أسود)
// ============================================================
export default function CapturedPieces({ label, pieces }) {
  const { colors: C } = useSettings();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", maxWidth: "510px" }}>
      <span style={{ fontSize: "var(--fs-caption)", color: C.txMut, fontWeight: 700, letterSpacing: "0.08em", minWidth: "92px", textAlign: "right", textTransform: "uppercase" }}>{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px", minWidth: "140px", minHeight: "26px", padding: "4px 8px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)" }}>
        {pieces.map((p, i) => (
          <span key={i} className="cm-capture-fade" style={{ display: "inline-flex" }}><PieceGlyph piece={p} size={17} /></span>
        ))}
      </div>
    </div>
  );
}
