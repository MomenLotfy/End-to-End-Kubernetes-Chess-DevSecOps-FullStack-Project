import { useSettings } from "../../contexts/SettingsContext";

// ============================================================
// components/ui/PieceGlyph.js — رسم القطعة بـ CSS بس (تدرّج لوني +
// ظلال تحاكي الخشب المصقول/المنحوت) — مش صور حقيقية، زي ما اتفقنا
// ============================================================
const WHITE_GRADIENT = "linear-gradient(160deg, #fff8ec 0%, #ecd6a8 45%, #c99a5c 75%, #a9713f 100%)";
const BLACK_GRADIENT = "linear-gradient(160deg, #6b4c30 0%, #3f2a18 45%, #241609 80%, #140c05 100%)";

export default function PieceGlyph({ piece, size = 44, medallion = false }) {
  const { colors: C, pieceSymbols: PIECES } = useSettings();
  if (!piece) return null;
  const isWhite = piece[0] === "w";
  const symbol = PIECES[piece];
  const isLetter = symbol && symbol.length === 1 && /[A-Za-z]/.test(symbol);

  const glyphStyle = {
    fontSize: isLetter ? size * 0.5 : size * 0.82,
    fontWeight: isLetter ? 800 : 400,
    fontFamily: isLetter ? "var(--font-display)" : "inherit",
    lineHeight: 1,
    backgroundImage: isWhite ? WHITE_GRADIENT : BLACK_GRADIENT,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    filter: isWhite
      ? "drop-shadow(0 1px 1px rgba(0,0,0,.55)) drop-shadow(0 2px 5px rgba(0,0,0,.35))"
      : "drop-shadow(0 1px 0 rgba(255,255,255,.06)) drop-shadow(0 2px 6px rgba(0,0,0,.6))",
    userSelect: "none",
  };

  if (!medallion) {
    return <span style={glyphStyle}>{symbol}</span>;
  }

  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: `radial-gradient(circle at 32% 28%, ${C.woodDk}, ${C.wood} 55%, ${C.woodBd} 100%)`,
      border: `1px solid ${C.goldSoft}`,
      boxShadow: "var(--sh-sm), inset 0 2px 4px rgba(255,255,255,0.08), inset 0 -3px 6px rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <span style={{ ...glyphStyle, fontSize: isLetter ? size * 0.4 : size * 0.56 }}>{symbol}</span>
    </div>
  );
}
