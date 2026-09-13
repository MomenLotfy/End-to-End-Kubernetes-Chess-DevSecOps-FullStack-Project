// ============================================================
// engine/chessEngine.js — Chess Rules Engine
// منطق اللعبة الخام: توليد الحركات، الكش، الحركات القانونية.
// اتنقل هنا زي ما هو من App.js من غير أي تغيير في السلوك.
// ============================================================
import { FILES } from "../constants/pieces";

export const initBoard = () => {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  ["R", "N", "B", "Q", "K", "B", "N", "R"].forEach((p, c) => {
    b[0][c] = "b" + p; b[1][c] = "bP"; b[6][c] = "wP"; b[7][c] = "w" + p;
  });
  return b;
};

export const pc = p => p ? p[0] : null;
export const pt = p => p ? p[1] : null;
export const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

export const rawMoves = (board, r, c, ep, cast) => {
  const p = board[r][c]; if (!p) return [];
  const col = pc(p), t = pt(p), opp = col === "w" ? "b" : "w", mv = [];
  const sl = (dr, dc) => {
    let nr = r + dr, nc = c + dc;
    while (inB(nr, nc)) {
      if (!board[nr][nc]) mv.push([nr, nc]);
      else { if (pc(board[nr][nc]) === opp) mv.push([nr, nc]); break; }
      nr += dr; nc += dc;
    }
  };
  if (t === "P") {
    const d = col === "w" ? -1 : 1, st = col === "w" ? 6 : 1;
    if (inB(r + d, c) && !board[r + d][c]) {
      mv.push([r + d, c]);
      if (r === st && !board[r + 2 * d][c]) mv.push([r + 2 * d, c]);
    }
    for (const dc of [-1, 1]) if (inB(r + d, c + dc)) {
      if (pc(board[r + d][c + dc]) === opp) mv.push([r + d, c + dc]);
      if (ep && ep[0] === r + d && ep[1] === c + dc) mv.push([r + d, c + dc]);
    }
  }
  if (t === "N") for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
    const nr = r + dr, nc = c + dc;
    if (inB(nr, nc) && pc(board[nr][nc]) !== col) mv.push([nr, nc]);
  }
  if (t === "B" || t === "Q") { sl(-1, -1); sl(-1, 1); sl(1, -1); sl(1, 1); }
  if (t === "R" || t === "Q") { sl(-1, 0); sl(1, 0); sl(0, -1); sl(0, 1); }
  if (t === "K") {
    for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (inB(nr, nc) && pc(board[nr][nc]) !== col) mv.push([nr, nc]);
    }
    if (cast) {
      const row = col === "w" ? 7 : 0;
      if (r === row && c === 4) {
        if (cast[col + "K"] && !board[row][5] && !board[row][6]) mv.push([row, 6]);
        if (cast[col + "Q"] && !board[row][3] && !board[row][2] && !board[row][1]) mv.push([row, 2]);
      }
    }
  }
  return mv;
};

export const appMv = (board, fr, fc, tr, tc) => {
  const nb = board.map(r => [...r]);
  nb[tr][tc] = nb[fr][fc]; nb[fr][fc] = null;
  return nb;
};

export const inChk = (board, col) => {
  let kr = -1, kc = -1;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === col + "K") { kr = r; kc = c; }
  if (kr === -1) return false;
  const opp = col === "w" ? "b" : "w";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (pc(board[r][c]) === opp && rawMoves(board, r, c, null, null).some(([mr, mc]) => mr === kr && mc === kc)) return true;
  return false;
};

export const getLegal = (board, r, c, ep, cast) => {
  const p = board[r][c]; if (!p) return [];
  const col = pc(p);
  return rawMoves(board, r, c, ep, cast).filter(([tr, tc]) => {
    let nb = appMv(board, r, c, tr, tc);
    if (pt(p) === "P" && ep && tr === ep[0] && tc === ep[1]) nb[col === "w" ? tr + 1 : tr - 1][tc] = null;
    if (pt(p) === "K" && Math.abs(tc - c) === 2) {
      const row = col === "w" ? 7 : 0;
      if (tc === 6) { nb[row][5] = nb[row][7]; nb[row][7] = null; }
      else { nb[row][3] = nb[row][0]; nb[row][0] = null; }
      if (inChk(appMv(board, r, c, row, tc === 6 ? 5 : 3), col)) return false;
    }
    return !inChk(nb, col);
  });
};

export const hasAny = (board, col, ep, cast) => {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (pc(board[r][c]) === col && getLegal(board, r, c, ep, cast).length > 0) return true;
  return false;
};

// ============================================================
// Replay support — Game Replay (Phase 2)
// بيرجّع لوحة الشطرنج بعد كل حركة من قائمة moveLog محفوظة
// (نفس منطق الـ castling/en-passant/promotion المستخدم وقت اللعب،
// بس هنا بيتطبق على تسلسل حركات جاهز بدل التفاعل المباشر)
// ============================================================
export const squareToRC = (square) => {
  const file = square[0], rank = parseInt(square[1], 10);
  return [8 - rank, FILES.indexOf(file)];
};

export const replayToSnapshots = (moveLog) => {
  let board = initBoard();
  const snapshots = [board.map(row => [...row])];

  for (const m of moveLog) {
    const [fr, fc] = squareToRC(m.from);
    const [tr, tc] = squareToRC(m.to);
    const col = pc(m.piece), type = pt(m.piece);
    const wasEmpty = board[tr][tc] === null;
    let nb = appMv(board, fr, fc, tr, tc);

    // Castling: الملك اتحرك خانتين أفقيًا → الرخ لازم يتحرك معاه
    if (type === "K" && Math.abs(tc - fc) === 2) {
      const row = col === "w" ? 7 : 0;
      if (tc === 6) { nb[row][5] = nb[row][7]; nb[row][7] = null; }
      else          { nb[row][3] = nb[row][0]; nb[row][0] = null; }
    }
    // En Passant: بيدق اتحرك بالقطر لخانة فاضية وفيه أكل مسجل
    if (type === "P" && fc !== tc && m.captured && wasEmpty) {
      const er = col === "w" ? tr + 1 : tr - 1;
      nb[er][tc] = null;
    }
    // Promotion
    if (m.promotion) nb[tr][tc] = col + m.promotion;

    board = nb;
    snapshots.push(board.map(row => [...row]));
  }
  return snapshots;
};

// ============================================================
// FEN support — Chess AI / Move Hints (Phase 3)
// محتاجينه عشان نبعت الوضع الحالي لمحرك Stockfish
// ============================================================
const FEN_LETTER = { K: "K", Q: "Q", R: "R", B: "B", N: "N", P: "P" };

export const boardToFEN = (board, turn, cast, ep, hist = []) => {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = "", empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const letter = FEN_LETTER[pt(p)];
      row += pc(p) === "w" ? letter : letter.toLowerCase();
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const placement = rows.join("/");
  const active = turn;
  let castling = "";
  if (cast?.wK) castling += "K"; if (cast?.wQ) castling += "Q";
  if (cast?.bK) castling += "k"; if (cast?.bQ) castling += "q";
  if (!castling) castling = "-";
  const epSquare = ep ? FILES[ep[1]] + (8 - ep[0]) : "-";
  const fullmove = Math.floor(hist.length / 2) + 1;
  return `${placement} ${active} ${castling} ${epSquare} 0 ${fullmove}`;
};

// بيحول حركة UCI ("e2e4", "e7e8q") لشكل {from,to,promotion} بتاعنا
export const parseUciMove = (uci) => {
  if (!uci || uci.length < 4) return null;
  const promoMap = { q: "Q", r: "R", b: "B", n: "N" };
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4] ? promoMap[uci[4]] : null,
  };
};
