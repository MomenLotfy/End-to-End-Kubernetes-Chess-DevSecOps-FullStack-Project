// src/components/AIPlay.js
import { useState, useEffect, useRef } from "react";
import { useSettings } from "../contexts/SettingsContext";
import useChessGame from "../hooks/useChessGame";
import useStockfish from "../hooks/useStockfish";
import { boardToFEN, squareToRC } from "../engine/chessEngine";
import ChessBoard from "./ChessBoard";
import CapturedPieces from "./CapturedPieces";
import GameStatusBar from "./GameStatusBar";
import PromotionModal from "./PromotionModal";
import Button from "./ui/Button";
import Icon from "./ui/Icon";
import Chip from "./ui/Chip";

const DIFFICULTIES = [
  { key: "easy",   label: "Easy",   skillLevel: 2,  movetimeMs: 400 },
  { key: "medium", label: "Medium", skillLevel: 8,  movetimeMs: 700 },
  { key: "hard",   label: "Hard",   skillLevel: 16, movetimeMs: 1200 },
];

// ============================================================
// components/AIPlay.js — Chess AI (Stockfish) + Move Hints
// ============================================================
export default function AIPlay({ onExit }) {
  const { colors: C } = useSettings();
  const [started, setStarted] = useState(false);
  const [difficulty, setDifficulty] = useState(DIFFICULTIES[1]);
  const [myColor, setMyColor] = useState("w");
  const [hint, setHint] = useState(null);
  const aiMovingRef = useRef(false);

  const { thinking, error: engineError, requestMove } = useStockfish();

  const game = useChessGame();

  const aiColor = myColor === "w" ? "b" : "w";
  const isAiTurn = started && game.turn === aiColor && !game.promo && !game.status?.match(/checkmate|stalemate|timeout/);

  useEffect(() => {
    if (!isAiTurn) return; // Only request AI move when it's AI's turn
    aiMovingRef.current = true;
    const fen = boardToFEN(game.board, game.turn, game.cast, game.ep, game.hist);
    requestMove(fen, { skillLevel: difficulty.skillLevel, movetimeMs: difficulty.movetimeMs }).then(mv => {
      aiMovingRef.current = false;
      if (mv) game.applyRemoteMove(mv);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAiTurn]);

  const startGame = (color) => {
    setMyColor(color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color);
    setStarted(true);
    game.reset();
    setHint(null);
  };

  const askHint = async () => {
    if (game.turn !== myColor || thinking) return;
    const fen = boardToFEN(game.board, game.turn, game.cast, game.ep, game.hist);
    const mv = await requestMove(fen, { skillLevel: 20, movetimeMs: 600 });
    if (mv) setHint({ from: squareToRC(mv.from), to: squareToRC(mv.to) });
  };

  const handleClick = (r, c) => {
    if (isAiTurn) return;
    setHint(null);
    game.click(r, c);
  };

  if (!started) {
    return (
      <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "24px", fontFamily: "var(--font-ui)", padding: "24px 16px" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-display)", fontWeight: 800, color: C.tx, letterSpacing: "0.02em" }}>Vs Computer</div>
          <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.2em", marginTop: "4px" }}>Powered by Stockfish</div>
        </div>

        <div className="cm-card" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "28px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", boxShadow: "var(--sh-lg)", width: "100%", maxWidth: "380px" }}>
          <div style={{ width: "100%" }}>
            <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: "10px" }}>Difficulty</div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
              {DIFFICULTIES.map(d => <Chip key={d.key} active={difficulty.key === d.key} onClick={() => setDifficulty(d)}>{d.label}</Chip>)}
            </div>
          </div>

          <div style={{ width: "100%" }}>
            <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: "10px" }}>Play As</div>
            <div style={{ display: "flex", gap: "10px", width: "100%", flexWrap: "wrap" }}>
              <Button variant="secondary" style={{ flex: 1 }} onClick={() => startGame("w")}>♔ White</Button>
              <Button variant="secondary" style={{ flex: 1 }} onClick={() => startGame("b")}>♚ Black</Button>
            </div>
            <div
              onClick={() => startGame("random")}
              className="cm-btn"
              role="button" tabIndex={0}
              onKeyDown={e => (e.key === "Enter" || e.key === " ") && startGame("random")}
              title="Random color"
              style={{
                width: "76px", height: "76px", margin: "14px auto 0", borderRadius: "var(--r-lg)",
                background: `linear-gradient(180deg, ${C.accentHv}, ${C.accent})`,
                color: "#fff8ec", border: "1px solid rgba(0,0,0,0.15)",
                boxShadow: "var(--sh-sm), inset 0 1px 0 rgba(255,255,255,0.15)",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: "5px", cursor: "pointer", userSelect: "none",
              }}
            >
              <Icon name="dice" size={30} />
              <span style={{ fontSize: "var(--fs-caption)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Random</span>
            </div>
          </div>

          {engineError && <div style={{ color: C.danger, fontSize: "var(--fs-caption)", textAlign: "center" }}>{engineError} — the local chess engine could not start.</div>}
        </div>
        <Button variant="ghost" size="sm" onClick={onExit}><Icon name="back" size={24} /> MENU</Button>
      </div>
    );
  }

  return (
    <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ui)", padding: "14px", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 12px", width: "100%", maxWidth: "510px" }}>
        <div onClick={onExit} className="cm-btn" style={{ color: C.txMut, cursor: "pointer", fontSize: "var(--fs-caption)", fontWeight: 600 }}><Icon name="back" size={24} /> MENU</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "1.05rem", fontWeight: 700, color: C.tx }}><Icon name="chess" size={24} /> vs Computer <span style={{ color: C.txMut, fontWeight: 400, fontSize: "var(--fs-caption)" }}>({difficulty.label})</span></div>
        <span style={{ fontSize: "var(--fs-caption)", color: C.txMut }}>{myColor === "w" ? "You: White" : "You: Black"}</span>
      </div>

      {/* Thinking indicator removed */}

      <CapturedPieces label="White takes" pieces={game.capt.w} />
      <ChessBoard board={game.board} sel={game.sel} mvSet={game.mvSet} lastMv={game.lastMv} ckKing={game.ckKing} onSquareClick={handleClick} hint={hint} />
      <CapturedPieces label="Black takes" pieces={game.capt.b} />

      <GameStatusBar status={game.status} turn={game.turn} hist={game.hist} onNewGame={() => { game.reset(); setHint(null); }} onUndo={game.undo} canUndo={game.canUndo}
        onHint={askHint} hintDisabled={game.turn !== myColor || thinking || !!game.promo} />

      <PromotionModal promo={game.promo} onPick={game.doPromo} />
    </div>
  );
}
