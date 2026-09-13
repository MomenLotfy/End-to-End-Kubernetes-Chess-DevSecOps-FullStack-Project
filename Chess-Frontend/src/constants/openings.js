// ============================================================
// constants/openings.js — Opening Book
// تسلسلات افتتاحيات شطرنج معروفة (SAN) — معلومة عامة مش محتوى محمي
// ============================================================
export const OPENINGS = [
  { name: "Ruy Lopez",               moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"] },
  { name: "Italian Game",            moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"] },
  { name: "Sicilian Defense",        moves: ["e4", "c5"] },
  { name: "Sicilian Najdorf",        moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"] },
  { name: "French Defense",          moves: ["e4", "e6"] },
  { name: "Caro-Kann Defense",       moves: ["e4", "c6"] },
  { name: "Pirc Defense",            moves: ["e4", "d6"] },
  { name: "Scandinavian Defense",    moves: ["e4", "d5"] },
  { name: "Alekhine's Defense",      moves: ["e4", "Nf6"] },
  { name: "King's Gambit",           moves: ["e4", "e5", "f4"] },
  { name: "Scotch Game",             moves: ["e4", "e5", "Nf3", "Nc6", "d4"] },
  { name: "Petrov's Defense",        moves: ["e4", "e5", "Nf3", "Nf6"] },
  { name: "Vienna Game",             moves: ["e4", "e5", "Nc3"] },
  { name: "Queen's Gambit",          moves: ["d4", "d5", "c4"] },
  { name: "Queen's Gambit Declined", moves: ["d4", "d5", "c4", "e6"] },
  { name: "Queen's Gambit Accepted", moves: ["d4", "d5", "c4", "dxc4"] },
  { name: "Slav Defense",            moves: ["d4", "d5", "c4", "c6"] },
  { name: "King's Indian Defense",   moves: ["d4", "Nf6", "c4", "g6"] },
  { name: "Nimzo-Indian Defense",    moves: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"] },
  { name: "Grünfeld Defense",        moves: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"] },
  { name: "Dutch Defense",           moves: ["d4", "f5"] },
  { name: "English Opening",         moves: ["c4"] },
  { name: "Réti Opening",            moves: ["Nf3", "d5", "c4"] },
  { name: "London System",           moves: ["d4", "d5", "Bf4"] },
  { name: "Catalan Opening",         moves: ["d4", "Nf6", "c4", "e6", "g3"] },
];

// hist بيحتوي لواحق زي + أو # (كش/كش مات) — نشيلها قبل المقارنة
const stripSuffix = (san) => san.replace(/[+#]$/, "");

// بيرجع أطول افتتاحية بتتطابق مع أول حركات اللعبة الحالية (hist)
export const detectOpening = (hist) => {
  const clean = hist.map(stripSuffix);
  let best = null;
  for (const o of OPENINGS) {
    if (o.moves.length > clean.length) continue;
    const matches = o.moves.every((m, i) => clean[i] === m);
    if (matches && (!best || o.moves.length > best.moves.length)) best = o;
  }
  return best;
};
