// ============================================================
// models/Score.js — Score Model (PostgreSQL)
// ============================================================
const { query } = require("../config/db");

const Score = {

  // حفظ نتيجة لعبة (gameId اختياري — بيربطها بسجل تفصيلي في جدول games لو موجود)
  async save({ userId, username, moves, duration, winner, gameMode, gameId }) {
    const result = await query(
      `INSERT INTO scores (user_id, username, moves, duration_seconds, winner, game_mode, game_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [userId, username, moves, duration, winner, gameMode || "local", gameId ?? null]
    );
    return result.rows[0];
  },

  // أعلى 10 نتائج عامة
  async getTopScores(limit = 10) {
    const result = await query(
      `SELECT
         s.id, s.username, s.moves, s.duration_seconds,
         s.winner, s.game_mode, s.played_at,
         RANK() OVER (ORDER BY s.moves ASC, s.duration_seconds ASC) as rank
       FROM scores s
       WHERE s.winner = true
       ORDER BY s.moves ASC, s.duration_seconds ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  // إحصائيات مستخدم معين
  async getUserStats(userId) {
    const result = await query(
      `SELECT
         COUNT(*)::int as total_games,
         COUNT(CASE WHEN winner = true THEN 1 END)::int as wins,
         COUNT(CASE WHEN winner = false THEN 1 END)::int as losses,
         MIN(CASE WHEN winner = true THEN moves END) as best_moves,
         MIN(CASE WHEN winner = true THEN duration_seconds END) as best_time,
         ROUND(
           COUNT(CASE WHEN winner = true THEN 1 END)::numeric /
           NULLIF(COUNT(*), 0) * 100, 1
         ) as win_rate
       FROM scores
       WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0];
  },

  // آخر 10 ألعاب لمستخدم
  async getUserHistory(userId, limit = 10) {
    const result = await query(
      `SELECT id, moves, duration_seconds, winner, game_mode, played_at, game_id
       FROM scores
       WHERE user_id = $1
       ORDER BY played_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },
};

module.exports = Score;
