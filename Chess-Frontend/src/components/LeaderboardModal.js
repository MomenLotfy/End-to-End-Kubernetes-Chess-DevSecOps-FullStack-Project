import { useState, useEffect } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { getLeaderboard, getEloLeaderboard } from "../api/client";

// ============================================================
// components/LeaderboardModal.js — نافذة لوحة الصدارة
// ============================================================
export default function LeaderboardModal({ onClose }) {
  const { colors: C } = useSettings();
  const [tab, setTab] = useState("scores");
  const [scores, setScores] = useState([]);
  const [eloPlayers, setEloPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const fetcher = tab === "scores" ? getLeaderboard() : getEloLeaderboard();
    fetcher.then(d => { if (tab === "scores") setScores(d.scores || []); else setEloPlayers(d.players || []); setLoading(false); }).catch(() => setLoading(false));
  }, [tab]);

  const tabStyle = (active) => ({ padding: "7px 16px", borderRadius: "var(--r-full)", cursor: "pointer", fontSize: "var(--fs-small)", fontWeight: 600, border: `1px solid ${active ? "transparent" : C.border}`, background: active ? `linear-gradient(180deg, ${C.accentHv}, ${C.accent})` : "transparent", color: active ? "#fff8ec" : C.txMut });
  const rankIcon = (i) => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`;
  const rowStyle = { display: "grid", gap: "8px", padding: "10px 14px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", alignItems: "center" };

  return (
    <div className="cm-fade-in" onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.8)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "14px" }}>
      <div className="cm-modal-pop" style={{ background: `linear-gradient(155deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "26px", width: "400px", maxWidth: "94vw", maxHeight: "80vh", display: "flex", flexDirection: "column", gap: "14px", boxShadow: "var(--sh-lg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.gold }}>🏆 Leaderboard</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.txMut, fontSize: "1.2rem", cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <div style={tabStyle(tab === "scores")} onClick={() => setTab("scores")}>Top Scores</div>
          <div style={tabStyle(tab === "elo")} onClick={() => setTab("elo")}>Top ELO</div>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>Loading...</div>
        ) : tab === "scores" ? (
          scores.length === 0 ? <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>No scores yet!</div> : (
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {scores.map((s, i) => (
                <div key={s.id} style={{ ...rowStyle, gridTemplateColumns: "28px 1fr 70px 60px" }}>
                  <span style={{ fontSize: "0.9rem", textAlign: "center" }}>{rankIcon(i)}</span>
                  <span style={{ color: C.tx, fontSize: "var(--fs-small)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.username}</span>
                  <span style={{ color: C.txMut, fontSize: "var(--fs-caption)", textAlign: "center" }}>{s.moves} moves</span>
                  <span style={{ color: C.txMut, fontSize: "var(--fs-caption)", textAlign: "center" }}>{s.duration_seconds}s</span>
                </div>
              ))}
            </div>
          )
        ) : (
          eloPlayers.length === 0 ? <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>No rated players yet!</div> : (
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {eloPlayers.map((p, i) => (
                <div key={p.id} style={{ ...rowStyle, gridTemplateColumns: "28px 1fr 70px" }}>
                  <span style={{ fontSize: "0.9rem", textAlign: "center" }}>{rankIcon(i)}</span>
                  <span style={{ color: C.tx, fontSize: "var(--fs-small)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.username}</span>
                  <span style={{ color: C.gold, fontSize: "var(--fs-caption)", fontWeight: 700, textAlign: "center" }}>{p.elo_rating}</span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
