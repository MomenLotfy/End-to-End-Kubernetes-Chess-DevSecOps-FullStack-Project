import { useState, useCallback } from "react";
import { FILES } from "../constants/pieces";
import { initBoard, pc, pt, appMv, inChk, getLegal, hasAny, squareToRC } from "../engine/chessEngine";
import { useSettings } from "../contexts/SettingsContext";

// ============================================================
// hooks/useChessGame.js — حالة اللعبة الكاملة + منطق الحركة
// + Undo Move + Sound Effects (Phase 1)
// + moveLog تفصيلي لكل حركة — أساس Game Replay (Phase 2)
// + applyRemoteMove — تطبيق حركة جاية من لاعب تاني (Multiplayer, Phase 3)
// ============================================================
export default function useChessGame({ onGameFinished, onMoveCommitted } = {}) {
  const { playSound } = useSettings();

  const [board, setBoard]     = useState(initBoard);
  const [turn, setTurn]       = useState("w");
  const [sel, setSel]         = useState(null);
  const [moves, setMoves]     = useState([]);
  const [ep, setEp]           = useState(null);
  const [cast, setCast]       = useState({ wK: true, wQ: true, bK: true, bQ: true });
  const [lastMv, setLastMv]   = useState(null);
  const [status, setStatus]   = useState(null);
  const [capt, setCapt]       = useState({ w: [], b: [] });
  const [hist, setHist]       = useState([]);
  const [moveLog, setMoveLog] = useState([]); // تفصيلي: {color,from,to,piece,captured,san,promotion}
  const [promo, setPromo]     = useState(null);
  const [gameStart, setGameStart] = useState(null);
  const [past, setPast]       = useState([]); // Undo stack — snapshot قبل كل حركة

  const sq = (r, c) => FILES[c] + (8 - r);

  const reset = () => {
    setBoard(initBoard()); setTurn("w"); setSel(null); setMoves([]); setEp(null);
    setCast({ wK: true, wQ: true, bK: true, bQ: true }); setLastMv(null); setStatus(null);
    setCapt({ w: [], b: [] }); setHist([]); setMoveLog([]); setPromo(null); setGameStart(Date.now()); setPast([]);
  };

  const loadFEN = (fen, persistedMoves = []) => {
    const [placement, activeColor, castling, enPassant] = fen.split(" ");
    const restored = placement.split("/").map(rank => {
      const row = [];
      for (const symbol of rank) {
        if (/\d/.test(symbol)) row.push(...Array(Number(symbol)).fill(null));
        else row.push((symbol === symbol.toUpperCase() ? "w" : "b") + symbol.toUpperCase());
      }
      return row;
    });
    if (restored.length !== 8 || restored.some(row => row.length !== 8)) throw new Error("Invalid recovered board");
    setBoard(restored); setTurn(activeColor); setSel(null); setMoves([]);
    setCast({ wK: castling.includes("K"), wQ: castling.includes("Q"), bK: castling.includes("k"), bQ: castling.includes("q") });
    setEp(enPassant === "-" ? null : squareToRC(enPassant));
    const last = persistedMoves.at(-1);
    setLastMv(last ? [...squareToRC(last.from), ...squareToRC(last.to)] : null);
    setStatus(null); setCapt({ w: [], b: [] }); setHist(persistedMoves.map(move => move.san).filter(Boolean));
    setMoveLog(persistedMoves); setPromo(null); setPast([]); setGameStart(Date.now());
  };

  // الـ snapshot بياخد الحالة الحالية (قبل ما الحركة تتنفذ) عشان الـ Undo
  const snapshot = () => ({ board, turn, sel, moves, ep, cast, lastMv, status, capt, hist, moveLog });

  const undo = () => {
    if (past.length === 0 || promo) return;
    const prev = past[past.length - 1];
    setBoard(prev.board); setTurn(prev.turn); setSel(prev.sel); setMoves(prev.moves);
    setEp(prev.ep); setCast(prev.cast); setLastMv(prev.lastMv); setStatus(prev.status);
    setCapt(prev.capt); setHist(prev.hist); setMoveLog(prev.moveLog); setPromo(null);
    setPast(p => p.slice(0, -1));
  };

  const finish = useCallback((nb, nt, nep, nc, note, moveEntry, silent) => {
    const chk = inChk(nb, nt), any = hasAny(nb, nt, nep, nc);
    let st = null; if (!any) st = chk ? "checkmate" : "stalemate"; else if (chk) st = "check";
    const suf = st === "checkmate" ? "#" : st === "check" ? "+" : "";
    const finalSan = note.replace(/[+#]?$/, suf);
    const finalEntry = { ...moveEntry, san: finalSan };

    setBoard(nb); setTurn(nt); setEp(nep); setCast(nc); setStatus(st);
    setHist(h => [...h, finalSan]);
    setMoveLog(m => [...m, finalEntry]);
    setSel(null); setMoves([]);

    if (st === "checkmate") playSound("checkmate");
    else if (st === "check") playSound("check");
    else if (moveEntry.captured) playSound("capture");
    else playSound("move");

    // مش هنبعت للسيرفر الحركات اللي إحنا استقبلناها من اللاعب التاني أصلاً (silent)
    if (!silent) onMoveCommitted?.(finalEntry, st);

    if (st === "checkmate" || st === "stalemate") {
      const dur = Math.floor((Date.now() - (gameStart || Date.now())) / 1000);
      setMoveLog(m => {
        onGameFinished?.({ moveCount: m.length, duration: dur, winner: st === "checkmate", moveHistory: m });
        return m;
      });
    }
  }, [gameStart, onGameFinished, onMoveCommitted, playSound]);

  // إنهاء اللعبة بسبب خارجي (نفاذ الوقت) — Move Timer
  const forceEnd = useCallback((reason) => {
    setStatus(reason);
    playSound("gameEnd");
    const dur = Math.floor((Date.now() - (gameStart || Date.now())) / 1000);
    setMoveLog(m => {
      onGameFinished?.({ moveCount: m.length, duration: dur, winner: true, moveHistory: m });
      return m;
    });
  }, [gameStart, onGameFinished, playSound]);

  // ==== تنفيذ حركة فعليًا (مستخدم من click() المحلي و applyRemoteMove البعيد) ====
  const applyMove = (fr, fc, tr, tc, opts = {}) => {
    const preMoveSnapshot = snapshot();
    const mp = board[fr][fc]; if (!mp) return;
    const col = pc(mp);
    let nb = appMv(board, fr, fc, tr, tc);
    const cap0 = board[tr][tc]; let nc = { ...cast };

    if (pt(mp) === "K") {
      nc[col + "K"] = false; nc[col + "Q"] = false;
      if (Math.abs(tc - fc) === 2) {
        const row = col === "w" ? 7 : 0;
        if (tc === 6) { nb[row][5] = nb[row][7]; nb[row][7] = null; }
        else { nb[row][3] = nb[row][0]; nb[row][0] = null; }
      }
    }
    if (pt(mp) === "R") {
      if (fr === 7 && fc === 7) nc.wK = false;
      if (fr === 7 && fc === 0) nc.wQ = false;
      if (fr === 0 && fc === 7) nc.bK = false;
      if (fr === 0 && fc === 0) nc.bQ = false;
    }
    if (tr === 7 && tc === 7) nc.wK = false;
    if (tr === 7 && tc === 0) nc.wQ = false;
    if (tr === 0 && tc === 7) nc.bK = false;
    if (tr === 0 && tc === 0) nc.bQ = false;

    let epCap = null;
    if (pt(mp) === "P" && ep && tr === ep[0] && tc === ep[1]) {
      const er = col === "w" ? tr + 1 : tr - 1; epCap = nb[er][tc]; nb[er][tc] = null;
    }
    const cp = cap0 || epCap;
    if (cp) setCapt(pv => ({ ...pv, [col]: [...pv[col], cp] }));

    const nep = pt(mp) === "P" && Math.abs(tr - fr) === 2 ? [(fr + tr) / 2, tc] : null;
    const nt = col === "w" ? "b" : "w";

    // ترقية بيدق محتاجة اختيار — لو جاية من لاعب تاني/replay يبقى الاختيار متبعت فعلاً (opts.promotion)
    if (pt(mp) === "P" && (tr === 0 || tr === 7) && !opts.promotion) {
      setLastMv([fr, fc, tr, tc]);
      setPromo({ fr, fc, tr, tc, col, nb, nt, nep, nc, capturedPiece: cp || null });
      setPast(pa => [...pa, preMoveSnapshot]);
      return;
    }

    if (opts.promotion) nb[tr][tc] = col + opts.promotion;

    const isCastle = pt(mp) === "K" && Math.abs(tc - fc) === 2, isCap = !!cp, t = pt(mp);
    const note = opts.promotion ? sq(tr, tc) + "=" + opts.promotion
      : isCastle ? (tc === 6 ? "O-O" : "O-O-O")
      : (t === "P" ? (isCap ? FILES[fc] + "x" : "") + sq(tr, tc) : (t + (isCap ? "x" : "") + sq(tr, tc)));

    setLastMv([fr, fc, tr, tc]);
    setPast(pa => [...pa, preMoveSnapshot]);
    finish(nb, nt, nep, nc, note, {
      color: col, from: sq(fr, fc), to: sq(tr, tc), piece: mp,
      captured: cp || null, promotion: opts.promotion || null,
    }, opts.silent);
  };

  // بيتنادى لما رسالة "move_made" توصل من السيرفر — بيطبّق نفس الحركة بالظبط من غير ما يبعتها تاني
  const applyRemoteMove = ({ from, to, promotion }) => {
    const [fr, fc] = squareToRC(from);
    const [tr, tc] = squareToRC(to);
    applyMove(fr, fc, tr, tc, { promotion: promotion || undefined, silent: true });
  };

  const doPromo = (t) => {
    const { fr, fc, tr, tc, col, nb, nt, nep, nc, capturedPiece } = promo;
    nb[tr][tc] = col + t; setPromo(null); setLastMv([fr, fc, tr, tc]);
    finish(nb, nt, nep, nc, sq(tr, tc) + "=" + t, {
      color: col, from: sq(fr, fc), to: sq(tr, tc), piece: col + "P",
      captured: capturedPiece || null, promotion: t,
    });
  };

  const click = (r, c) => {
    if (status === "checkmate" || status === "stalemate" || status === "timeout" || promo) return;
    const p = board[r][c];
    if (sel) {
      const [sr, sc] = sel;
      if (moves.some(([mr, mc]) => mr === r && mc === c)) {
        applyMove(sr, sc, r, c);
        return;
      }
      if (p && pc(p) === turn) { setSel([r, c]); setMoves(getLegal(board, r, c, ep, cast)); return; }
      setSel(null); setMoves([]); return;
    }
    if (p && pc(p) === turn) { setSel([r, c]); setMoves(getLegal(board, r, c, ep, cast)); }
  };

  const mvSet = new Set(moves.map(([r, c]) => `${r},${c}`));
  let ckKing = null;
  if (status === "check" || status === "checkmate")
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === turn + "K") ckKing = `${r},${c}`;

  return {
    board, turn, sel, moves, mvSet, lastMv, status, capt, hist, moveLog, promo, ckKing, cast, ep,
    canUndo: past.length > 0 && !promo,
    reset, loadFEN, click, doPromo, undo, forceEnd, applyRemoteMove,
  };
}
