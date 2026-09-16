// ============================================================
// models/Game.js — Game Model (PostgreSQL)
// كل عملية تكتب/تقرأ حالة لعبة نشطة بتتحصل جوا transaction واحدة
// وبتتحقق من rowCount — لا استثناءات.
// ============================================================
const { query, pool } = require("../config/db");

const Game = {
  // ----------------------------------------------------------
  // Transaction helper: connect → BEGIN → callback(client) → COMMIT → release
  // On failure: ROLLBACK → release → rethrow the ORIGINAL error.
  // If ROLLBACK itself fails, the original error is never swallowed —
  // it is attached to the thrown error as `.originalError`.
  // ----------------------------------------------------------
  async runInTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        const combined = new Error(
          `Transaction rollback failed after original error: ${err.message}; rollback error: ${rollbackErr.message}`
        );
        combined.originalError = err;
        combined.rollbackError = rollbackErr;
        throw combined;
      }
      throw err;
    } finally {
      client.release();
    }
  },

  // ----------------------------------------------------------
  // Reads — safe to run outside a transaction, used by routes/pages
  // that are not part of the authoritative multiplayer flow.
  // ----------------------------------------------------------
  async findByRoomId(roomId) {
    const result = await query("SELECT * FROM games WHERE room_id = $1", [roomId]);
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await query("SELECT * FROM games WHERE id = $1", [id]);
    return result.rows[0] || null;
  },

<<<<<<< HEAD
=======
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

  // تحديث الفين بعد كل حركة (authoritative board)
  async updateBoardFEN(roomId, fen) {
    const res = await query(
      `UPDATE games SET board_fen = $2 WHERE room_id = $1 RETURNING *`,
      [roomId, fen]
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

>>>>>>> fix/server-authoritative-game
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
<<<<<<< HEAD

  // ----------------------------------------------------------
  // Transaction-scoped writes — MUST be called with the `client` handed
  // to a runInTransaction callback. Every one of these checks rowCount
  // and throws if the write did not affect exactly one row, so a bad
  // write always aborts the whole transaction instead of silently
  // producing a partially-updated game.
  // ----------------------------------------------------------

  // إنشاء لعبة جديدة (create_room أو rematch) — room_id يكون null في الـ rematch
  async createWithClient(client, { roomId, whiteUserId, whiteUsername, gameMode = "multiplayer", initialFen }) {
    const result = await client.query(
      `INSERT INTO games (room_id, white_user_id, white_username, game_mode, status, board_fen)
       VALUES ($1, $2, $3, $4, 'in_progress', $5)
       RETURNING *`,
      [roomId ?? null, whiteUserId ?? null, whiteUsername, gameMode, initialFen ?? null]
    );
    if (result.rowCount !== 1) {
      throw new Error("Failed to create game row");
    }
    return result.rows[0];
  },

  // انضمام اللاعب الأسود عن طريق gameId — الشرط في WHERE يمنع أي double-join
  // (سواء كان نفس الطلب اتكرر أو اتنين join_room جم في نفس اللحظة).
  async joinBlackByIdWithClient(client, gameId, { blackUserId, blackUsername }) {
    const result = await client.query(
      `UPDATE games
       SET black_user_id = $2, black_username = $3
       WHERE id = $1 AND status = 'in_progress' AND black_user_id IS NULL AND black_username IS NULL
       RETURNING *`,
      [gameId, blackUserId ?? null, blackUsername]
    );
    if (result.rowCount !== 1) {
      throw new Error("Failed to join black player: game not found, not in progress, or already has a black player");
    }
    return result.rows[0];
  },

  // تحديث الـ FEN بعد كل حركة — معتمد على gameId مش roomId
  async updateBoardFENByIdWithClient(client, gameId, fen) {
    const result = await client.query(
      `UPDATE games SET board_fen = $2 WHERE id = $1 AND status = 'in_progress' RETURNING *`,
      [gameId, fen]
    );
    if (result.rowCount !== 1) {
      throw new Error("Failed to update board FEN: game not found or not in progress");
    }
    return result.rows[0];
  },

  // إنهاء اللعبة — الشرط status='in_progress' في الـ WHERE هو الحارس ضد
  // أي double finalization: لو اللعبة خلصت خلاص، rowCount هيبقى 0.
  async finishByIdWithClient(client, gameId, { result: gameResult, winnerColor }) {
    const res = await client.query(
      `UPDATE games
       SET status = 'finished', result = $2, winner_color = $3, ended_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'in_progress'
       RETURNING *`,
      [gameId, gameResult, winnerColor ?? null]
    );
    if (res.rowCount !== 1) {
      throw new Error("ALREADY_FINALIZED");
    }
    return res.rows[0];
  },

  // قراءة الـ rating مع قفل الصف (FOR UPDATE) جوا نفس الـ transaction —
  // بيمنع lost-update لو اتنين finalization لنفس اللاعب حصلوا في نفس اللحظة
  // (نظريا مستحيل مع guard الـ status='in_progress'، لكنه دفاع إضافي).
  async getUserForUpdateWithClient(client, userId) {
    const res = await client.query(
      `SELECT id, elo_rating FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (res.rowCount !== 1) {
      throw new Error(`User ${userId} not found during ELO settlement`);
    }
    return res.rows[0];
  },

  async updateEloWithClient(client, userId, newElo) {
    const res = await client.query(
      `UPDATE users SET elo_rating = $2 WHERE id = $1 RETURNING id, username, elo_rating`,
      [userId, newElo]
    );
    if (res.rowCount !== 1) {
      throw new Error(`Failed to update ELO for user ${userId}`);
    }
    return res.rows[0];
=======
  // Run multiple DB operations in a single transaction
  async runInTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
>>>>>>> fix/server-authoritative-game
  },
};

module.exports = Game;
