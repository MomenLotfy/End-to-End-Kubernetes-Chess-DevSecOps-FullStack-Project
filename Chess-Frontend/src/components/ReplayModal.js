// src/components/ReplayModal.js
import { useState, useEffect, useMemo, useRef } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { getGameMoves } from "../api/client";
import { replayToSnapshots } from "../engine/chessEngine";
import ChessBoard from "./ChessBoard";
import Button from "./ui/Button";
import Icon from "./ui/Icon";

// ============================================================
// components/ReplayModal.js — إعادة مشاهدة لعبة محفوظة (Game Replay)
// ============================================================
export default function ReplayModal({ gameId, onClose }) {
  const { colors: C } = useSettings();
  const [moves, setMoves] = useState(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState("");
  const intervalRef = useRef(null);

  useEffect(() => {
    getGameMoves(gameId)
      .then(({ moves }) => {
        setMoves(moves.map(m => ({
          color: m.player_color, from: m.from_square, to: m.to_square, piece: m.piece,
          captured: m.captured_piece, promotion: (m.san?.match(/=([QRBN])/) || [])[1] || null, san: m.san,
        })));
      })
      .catch(e => setErr(e.message));
  }, [gameId]);

  const snapshots = useMemo(() => moves ? replayToSnapshots(moves) : null, [moves]);

  useEffect(() => {
    if (!playing || !snapshots) return;
    intervalRef.current = setInterval(() => {
      setStep(s => { if (s >= snapshots.length - 1) { setPlaying(false); return s; } return s + 1; });
    }, 900);
    return () => clearInterval(intervalRef.current);
  }, [playing, snapshots]);

  const overlay = { position: "fixed", inset: 0, background: "rgba(6,4,2,0.85)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 };

  if (err) {
    return (
      <div className="cm-fade-in" style={overlay}>
        <div className="cm-modal-pop" style={{ background: C.modalBg, border: `1px solid ${C.border}`, borderRadius: "var(--r-lg)", padding: "24px", color: C.tx, display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
          <div>Couldn't load this game's replay.</div>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }
  if (!moves || !snapshots) {
    return <div className="cm-fade-in" style={overlay}><div style={{ color: C.tx }}>Loading replay...</div></div>;
  }

  const iconBtn = { background: C.pnl, color: C.tx, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", padding: "7px 13px", cursor: "pointer", fontSize: "0.9rem" };

  return (
    <div className="cm-fade-in" onClick={e => e.target === e.currentTarget && onClose()} style={{ ...overlay, padding: "min(12px, 3vw)" }}>
      <div className="cm-modal-pop" style={{ background: `linear-gradient(155deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "min(20px, 4vw)", maxWidth: "94vw", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", maxHeight: "92vh", overflowY: "auto", boxShadow: "var(--sh-lg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
          <span style={{ color: C.gold, fontWeight: 700, fontFamily: "var(--font-display)", fontSize: "var(--fs-h2)" }}>▶ Game Replay</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.txMut, fontSize: "1.2rem", cursor: "pointer" }}><Icon name="back" size={24} /></button>
        </div>

        {/* Modal adds its own chrome, so shrink the fluid square locally on phones. */}
        <div style={{ "--sq": "min(7.8vw, 60px)" }}>
          <ChessBoard board={snapshots[step]} sel={null} mvSet={new Set()} lastMv={null} ckKing={null} onSquareClick={() => {}} />
        </div>

        <div className="cm-btn" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div className="cm-btn" style={iconBtn} onClick={() => setStep(0)}>⏮</div>
          <div className="cm-btn" style={iconBtn} onClick={() => setStep(s => Math.max(0, s - 1))}>◀</div>
          <div className="cm-btn" style={{ ...iconBtn, background: `linear-gradient(180deg, ${C.accentHv}, ${C.accent})`, color: "#fff8ec", border: "none" }} onClick={() => setPlaying(p => !p)}>{playing ? "⏸" : "▶"}</div>
          <div className="cm-btn" style={iconBtn} onClick={() => setStep(s => Math.min(snapshots.length - 1, s + 1))}>▶</div>
          <div className="cm-btn" style={iconBtn} onClick={() => setStep(snapshots.length - 1)}>⏭</div>
        </div>

        <div style={{ fontSize: "var(--fs-caption)", color: C.txMut }}>Move {step} / {moves.length}</div>

        <div style={{ maxHeight: "70px", overflowY: "auto", padding: "6px 10px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-sm)", width: "100%", maxWidth: "480px", display: "flex", flexWrap: "wrap", gap: "2px 8px", fontSize: "var(--fs-caption)" }}>
          {moves.map((m, i) => (
            <span key={i} onClick={() => setStep(i + 1)} style={{ cursor: "pointer", color: step === i + 1 ? C.gold : C.txMut, fontWeight: step === i + 1 ? 700 : 400 }}>
              {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}{m.san}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
