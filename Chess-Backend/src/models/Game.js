const { query, pool } = require("../config/db");

function requireOne(result, operation) {
  if (result.rowCount !== 1) throw new Error(`${operation} affected ${result.rowCount} rows`);
  return result.rows[0];
}

const Game = {
  async create({ roomId, whiteUserId, whiteUsername, gameMode = "multiplayer" }, client = null) {
    const result = await (client || { query }).query(
      `INSERT INTO games (room_id, white_user_id, white_username, game_mode, status, board_fen)
       VALUES ($1,$2,$3,$4,'in_progress',$5) RETURNING *`,
      [roomId, whiteUserId ?? null, whiteUsername, gameMode, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]
    );
    return requireOne(result, "create game");
  },

  async claimBlack(gameId, { blackUserId, blackUsername }) {
    return this.runInTransaction(async client => {
      const game = await client.query("SELECT * FROM games WHERE id=$1 FOR UPDATE", [gameId]);
      requireOne(game, "lock game for join");
      if (game.rows[0].status !== "in_progress" || game.rows[0].black_username) return null;
      const result = await client.query(
        `UPDATE games SET black_user_id=$2, black_username=$3
         WHERE id=$1 AND status='in_progress' AND black_username IS NULL RETURNING *`,
        [gameId, blackUserId ?? null, blackUsername]
      );
      return requireOne(result, "join black player");
    });
  },

  async joinBlack(roomId, player) {
    const found = await this.findByRoomId(roomId);
    if (!found) throw new Error("Game not found for room");
    return this.claimBlack(found.id, player);
  },

  async joinBlackById(id, player, client = null) {
    const result = await (client || { query }).query(
      `UPDATE games SET black_user_id=$2, black_username=$3
       WHERE id=$1 AND status='in_progress' AND black_username IS NULL RETURNING *`,
      [id, player.blackUserId ?? null, player.blackUsername]
    );
    return requireOne(result, "join black player by game id");
  },

  async findByRoomId(roomId) {
    const result = await query("SELECT * FROM games WHERE room_id=$1", [roomId]);
    return result.rows[0] || null;
  },
  async findById(id) {
    const result = await query("SELECT * FROM games WHERE id=$1", [id]);
    return result.rows[0] || null;
  },
  async findRecoverable() {
    const result = await query(
      `SELECT g.*, COALESCE(json_agg(m ORDER BY m.move_number) FILTER (WHERE m.id IS NOT NULL), '[]') AS persisted_moves
       FROM games g LEFT JOIN moves m ON m.game_id=g.id
       WHERE g.status='in_progress' AND g.game_mode='multiplayer' AND g.room_id IS NOT NULL
       GROUP BY g.id ORDER BY g.id`
    );
    return result.rows;
  },

  async updateBoardFEN(gameId, fen, client = null) {
    const result = await (client || { query }).query(
      "UPDATE games SET board_fen=$2 WHERE id=$1 AND status='in_progress' RETURNING *", [gameId, fen]
    );
    return requireOne(result, "update game board");
  },

  async finishById(id, { result: gameResult, winnerColor }, client = null) {
    const result = await (client || { query }).query(
      `UPDATE games SET status='finished', result=$2, winner_color=$3, ended_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND status='in_progress' RETURNING *`, [id, gameResult, winnerColor ?? null]
    );
    return result.rows[0] || null;
  },
  async finish(roomId, details) {
    const game = await this.findByRoomId(roomId);
    return game ? this.finishById(game.id, details) : null;
  },
  async abandonMany(gameIds) {
    if (!gameIds.length) return 0;
    const result = await query(
      `UPDATE games SET status='abandoned', result='process_failure', ended_at=CURRENT_TIMESTAMP
       WHERE id=ANY($1::int[]) AND status='in_progress'`, [gameIds]
    );
    return result.rowCount;
  },
  async getUserGames(userId, limit = 10) {
    const result = await query(
      "SELECT * FROM games WHERE white_user_id=$1 OR black_user_id=$1 ORDER BY started_at DESC LIMIT $2",
      [userId, limit]
    );
    return result.rows;
  },
  async runInTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally { client.release(); }
  },
};
module.exports = Game;
