// ============================================================
// models/Game.js — Game Model (PostgreSQL)
// بديل تخزين الغرف في الميموري بس — كل لعبة بقت لها سطر دائم
// ============================================================
const { query } = require("../config/db");

const Game = {

  // إنشاء لعبة جديدة (بتتنادى وقت create_room)
  async create({ roomId, whiteUserId, whiteUsername, gameMode = "multiplayer" }) {
    const result = await query(
      `INSERT INTO games (room_id, white_user_id, white_username, game_mode, status)
       VALUES ($1, $2, $3, $4, 'in_progress')
       RETURNING *`,
      [roomId, whiteUserId ?? null, whiteUsername, gameMode]
    );
    return result.rows[0];
  },

  // انضمام اللاعب الأسود عن طريق room_id (multiplayer)
  async joinBlack(roomId, { blackUserId, blackUsername }) {
    const result = await query(
      `UPDATE games
       SET black_user_id = $2, black_username = $3
       WHERE room_id = $1
       RETURNING *`,
      [roomId, blackUserId ?? null, blackUsername]
    );
    return result.rows[0] || null;
  },

  // انضمام اللاعب الأسود عن طريق id مباشرة (لعب local/rematch مفيش لها room_id)
  async joinBlackById(id, { blackUserId, blackUsername }) {
    const result = await query(
      `UPDATE games
       SET black_user_id = $2, black_username = $3
       WHERE id = $1
       RETURNING *`,
      [id, blackUserId ?? null, blackUsername]
    );
    return result.rows[0] || null;
  },

  async findByRoomId(roomId) {
    const result = await query("SELECT * FROM games WHERE room_id = $1", [roomId]);
    return result.rows[0] || null;
  },

  // للـ Game Replay — جلب لعبة عن طريق الـ id
  async findById(id) {
    const result = await query("SELECT * FROM games WHERE id = $1", [id]);
    return result.rows[0] || null;
  },

  // إنهاء اللعبة عن طريق room_id (multiplayer)
  async finish(roomId, { result: gameResult, winnerColor }) {
    const res = await query(
      `UPDATE games
       SET status = 'finished', result = $2, winner_color = $3, ended_at = CURRENT_TIMESTAMP
       WHERE room_id = $1
       RETURNING *`,
      [roomId, gameResult, winnerColor ?? null]
    );
    return res.rows[0] || null;
  },

  // إنهاء اللعبة عن طريق id مباشرة (local games مفيش لها room_id)
  async finishById(id, { result: gameResult, winnerColor }) {
    const res = await query(
      `UPDATE games
       SET status = 'finished', result = $2, winner_color = $3, ended_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id, gameResult, winnerColor ?? null]
    );
    return res.rows[0] || null;
  },

  // آخر ألعاب مستخدم معيّن (لصفحة الـ Profile / Replay list)
  async getUserGames(userId, limit = 10) {
    const result = await query(
      `SELECT * FROM games
       WHERE white_user_id = $1 OR black_user_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },
};

module.exports = Game;
