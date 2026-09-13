import { useSettings } from "../contexts/SettingsContext";

// ============================================================
// components/StatsChart.js — Win/Loss Stats Chart (SVG donut)
// ============================================================
export default function StatsChart({ wins = 0, losses = 0 }) {
  const { colors: C } = useSettings();
  const total = wins + losses;
  const winPct = total > 0 ? (wins / total) * 100 : 0;
  const R = 40, CIRC = 2 * Math.PI * R;
  const winDash = (winPct / 100) * CIRC;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
      <svg width="104" height="104" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={R} fill="none" stroke={C.danger} strokeWidth="11" opacity="0.35" />
        <circle cx="50" cy="50" r={R} fill="none" stroke={C.success} strokeWidth="11"
          strokeDasharray={`${winDash} ${CIRC - winDash}`} strokeDashoffset={CIRC / 4}
          transform="rotate(-90 50 50)" strokeLinecap="round" style={{ transition: "stroke-dasharray var(--dur-slow) var(--ease)" }} />
        <text x="50" y="56" textAnchor="middle" fontSize="17" fontWeight="700" fontFamily="var(--font-display)" fill={C.tx}>{total > 0 ? `${Math.round(winPct)}%` : "—"}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "var(--fs-small)" }}>
        <div style={{ color: C.success, fontWeight: 600 }}>● Wins: <strong>{wins}</strong></div>
        <div style={{ color: C.danger, fontWeight: 600 }}>● Losses/Draws: <strong>{losses}</strong></div>
        <div style={{ color: C.txMut, fontSize: "var(--fs-caption)" }}>Total games: {total}</div>
      </div>
    </div>
  );
}
