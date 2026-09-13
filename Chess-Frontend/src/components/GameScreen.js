import { useMemo, useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import ChessBoard from "./ChessBoard";
import CapturedPieces from "./CapturedPieces";
import GameStatusBar from "./GameStatusBar";
import PromotionModal from "./PromotionModal";
import useGameTimer from "../hooks/useGameTimer";
import useStockfish from "../hooks/useStockfish";
import { detectOpening } from "../constants/openings";
import { boardToFEN, squareToRC } from "../engine/chessEngine";

// ============================================================
// components/GameScreen.js — شاشة اللعب المحلية (Premium Chess Club)
// ============================================================
export default function GameScreen({ user, game, onExit, timerMinutes }) {
  const { colors: C } = useSettings();
  const { board, sel, mvSet, lastMv, status, turn, cast, ep, capt, hist, promo, ckKing, click, doPromo, reset, undo, canUndo, forceEnd } = game;
  const [hint, setHint] = useState(null);
  const { thinking, requestMove } = useStockfish();

  const opening = useMemo(() => detectOpening(hist), [hist]);

  const isRunning = !promo && !status;
  const timer = useGameTimer({
    minutes: timerMinutes,
    turn,
    isRunning,
    onTimeout: (loserColor) => forceEnd("timeout", loserColor),
  });

  const askHint = async () => {
    if (status || promo) return;
    const fen = boardToFEN(board, turn, cast, ep, hist);
    const mv = await requestMove(fen, { skillLevel: 20, movetimeMs: 600 });
    if (mv) setHint({ from: squareToRC(mv.from), to: squareToRC(mv.to) });
  };

  const handleClick = (r, c) => { setHint(null); click(r, c); };

  const shareGame = async () => {
    const resultLine = status === "checkmate" ? `Checkmate — ${turn === "w" ? "Black" : "White"} wins!`
      : status === "stalemate" ? "Draw by stalemate"
      : status === "timeout" ? `${turn === "w" ? "White" : "Black"} ran out of time`
      : "Game in progress";
    const pgnish = hist.map((m, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${m}` : m)).join(" ");
    const text = `♟ Chess Game — ${resultLine}\n${pgnish || "(no moves yet)"}`;
    try {
      await navigator.clipboard.writeText(text);
      alert("Copied game summary to clipboard!");
    } catch {
      window.prompt("Copy your game summary:", text);
    }
  };

  const clockCard = (label, time, dotColor, isLow, isActive) => (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px", padding: "8px 16px", borderRadius: "var(--r-md)",
      background: isActive ? C.pnl : "transparent", border: `1px solid ${isActive ? C.border : "transparent"}`,
      transition: "background var(--dur-base) var(--ease), border-color var(--dur-base) var(--ease)",
    }}>
      <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: dotColor, boxShadow: isActive ? `0 0 6px ${dotColor}` : "none" }} />
      <div>
        <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
        <div style={{ fontSize: "1.05rem", fontWeight: 700, fontFamily: "var(--font-display)", color: isLow ? C.danger : C.tx, fontVariantNumeric: "tabular-nums" }}>{time}</div>
      </div>
    </div>
  );

  return (
    <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ui)", padding: "14px", gap: "10px" }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: "510px" }}>
        <div onClick={onExit} className="cm-btn" style={{ color: C.txMut, cursor: "pointer", fontSize: "var(--fs-caption)", letterSpacing: "0.08em", fontWeight: 600 }}>← MENU</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "1.15rem", fontWeight: 700, color: C.tx, letterSpacing: "0.04em" }}>♞ Chess</div>
        {user ? <span style={{ fontSize: "var(--fs-caption)", color: C.txMut, maxWidth: "80px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.username}</span> : <span style={{ width: "60px" }} />}
      </div>

      {timerMinutes !== null && (
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: "510px" }}>
          {clockCard("White", timer.white, "#fff", timer.lowW, turn === "w" && isRunning)}
          {clockCard("Black", timer.black, "#1a1a1a", timer.lowB, turn === "b" && isRunning)}
        </div>
      )}

      <CapturedPieces label="White takes" pieces={capt.w} />
      <ChessBoard board={board} sel={sel} mvSet={mvSet} lastMv={lastMv} ckKing={ckKing} onSquareClick={handleClick} hint={hint} />
      <CapturedPieces label="Black takes" pieces={capt.b} />

      <GameStatusBar status={status} turn={turn} hist={hist} onNewGame={reset} onUndo={undo} canUndo={canUndo} onShare={shareGame} opening={opening}
        onHint={askHint} hintDisabled={!!status || thinking} />

      <PromotionModal promo={promo} onPick={doPromo} />
    </div>
  );
}
