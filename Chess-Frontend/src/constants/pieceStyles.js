// ============================================================
// constants/pieceStyles.js — أطقم رموز القطع (Piece Styles)
// ============================================================
export const PIECE_STYLES = {
  classic: {
    key: "classic", name: "Classic",
    symbols: {
      wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
      bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
    },
  },
  minimal: {
    key: "minimal", name: "Minimal",
    symbols: {
      wK: "K", wQ: "Q", wR: "R", wB: "B", wN: "N", wP: "P",
      bK: "K", bQ: "Q", bR: "R", bB: "B", bN: "N", bP: "P",
    },
  },
};

export const PIECE_STYLE_LIST = Object.values(PIECE_STYLES).map(s => ({ key: s.key, name: s.name }));
