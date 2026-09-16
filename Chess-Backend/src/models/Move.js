// ============================================================
// models/Move.js — Move Model (PostgreSQL)
// أساس Game Replay + Opening Book (Phase 2)
// ============================================================
const { query } = require("../config/db");

const Move = {

  // تسجيل حركة واحدة جوا transaction (نفس الـ client بتاع UPDATE games)
  async recordWithClient(client, { gameId, moveNumber, playerColor, from, to, piece, capturedPiece, san, fenAfter }) {
    const result = await client.query(
      `INSERT INTO moves
         (game_id, move_number, player_color, from_square, to_square, piece, captured_piece, san, fen_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [gameId, moveNumber, playerColor, from, to, piece, capturedPiece ?? null, san ?? null, fenAfter ?? null]
    );
    if (result.rowCount !== 1) {
      throw new Error("Failed to record move");
    }
    return result.rows[0];
  },

  // كل حركات لعبة معينة بالترتيب — ده اللي بيغذّي الـ Replay (read-only, خارج transaction)
  async getByGameId(gameId) {
    const result = await query(
      `SELECT * FROM moves WHERE game_id = $1 ORDER BY move_number ASC`,
      [gameId]
    );
    return result.rows;
  },
};

module.exports = Move;
