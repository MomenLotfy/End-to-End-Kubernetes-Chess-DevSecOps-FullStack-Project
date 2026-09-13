// ============================================================
// models/Move.js — Move Model (PostgreSQL)
// أساس Game Replay + Opening Book (Phase 2)
// ============================================================
const { query } = require("../config/db");

const Move = {

  // تسجيل حركة واحدة
  async record({ gameId, moveNumber, playerColor, from, to, piece, capturedPiece, san, fenAfter }) {
    const result = await query(
      `INSERT INTO moves
         (game_id, move_number, player_color, from_square, to_square, piece, captured_piece, san, fen_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [gameId, moveNumber, playerColor, from, to, piece, capturedPiece ?? null, san ?? null, fenAfter ?? null]
    );
    return result.rows[0];
  },

  // كل حركات لعبة معينة بالترتيب — ده اللي بيغذّي الـ Replay
  async getByGameId(gameId) {
    const result = await query(
      `SELECT * FROM moves WHERE game_id = $1 ORDER BY move_number ASC`,
      [gameId]
    );
    return result.rows;
  },
};

module.exports = Move;
