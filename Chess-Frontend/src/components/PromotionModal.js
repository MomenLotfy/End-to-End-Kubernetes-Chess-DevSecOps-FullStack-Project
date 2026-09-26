import { useSettings } from "../contexts/SettingsContext";
import PieceGlyph from "./ui/PieceGlyph";

const NAMES = { Q: "Queen", R: "Rook", B: "Bishop", N: "Knight" };

// ============================================================
// components/PromotionModal.js — اختيار قطعة الترقية (ميداليات دائرية)
// ============================================================
export default function PromotionModal({ promo, onPick }) {
  const { colors: C } = useSettings();
  if (!promo) return null;

  return (
    <div className="cm-fade-in" style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.8)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "12px" }}>
      <div className="cm-modal-pop" style={{
        background: `linear-gradient(160deg, ${C.surfaceHover}, ${C.modalBg})`,
        border: `1px solid ${C.gold}55`,
        borderRadius: "var(--r-xl)",
        padding: "min(30px, 6vw) min(36px, 7vw)",
        maxWidth: "94vw",
        display: "flex", flexDirection: "column", alignItems: "center", gap: "20px",
        boxShadow: `var(--sh-lg), 0 0 0 1px ${C.goldSoft}`,
      }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.gold, letterSpacing: "0.04em", textAlign: "center" }}>
          Promote Pawn
        </div>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", justifyContent: "center" }}>
          {["Q", "R", "B", "N"].map((t, i) => (
            <div key={t} onClick={() => onPick(t)} className="cm-btn"
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <div style={{
                width: "min(76px, 17vw)", height: "min(76px, 17vw)", borderRadius: "50%", flexShrink: 0,
                background: `radial-gradient(circle at 32% 28%, ${C.woodDk}, ${C.wood} 55%, ${C.woodBd} 100%)`,
                border: i === 0 ? `2px solid ${C.gold}` : `1px solid ${C.pnlBd}`,
                boxShadow: i === 0 ? `var(--sh-md), 0 0 18px ${C.goldSoft}` : "var(--sh-sm)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }} className={i === 0 ? "cm-gold-pulse" : ""}>
                <PieceGlyph piece={promo.col + t} size="min(54px, 12vw)" />
              </div>
              <div style={{ fontSize: "var(--fs-caption)", fontWeight: 600, letterSpacing: "0.1em", color: i === 0 ? C.gold : C.txMut, textTransform: "uppercase" }}>{NAMES[t]}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
