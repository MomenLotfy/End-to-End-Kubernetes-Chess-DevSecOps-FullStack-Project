import { useState, useCallback } from "react";
import { getBestMoveUci } from "../utils/stockfish";
import { parseUciMove } from "../engine/chessEngine";

// ============================================================
// hooks/useStockfish.js — واجهة React لمحرك Stockfish
// بيستخدمها كل من Chess AI (خصم الكمبيوتر) و Move Hints
// ============================================================
export default function useStockfish() {
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");

  const requestMove = useCallback(async (fen, opts) => {
    setThinking(true); setError("");
    try {
      const uci = await getBestMoveUci(fen, opts);
      return uci ? parseUciMove(uci) : null;
    } catch (e) {
      setError(e.message || "Engine error");
      return null;
    } finally {
      setThinking(false);
    }
  }, []);

  return { thinking, error, requestMove };
}
