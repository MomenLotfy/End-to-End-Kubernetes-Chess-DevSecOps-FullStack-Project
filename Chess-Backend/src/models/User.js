// ============================================================
// models/User.js — User Model (PostgreSQL)
// ============================================================
const { query, pool } = require("../config/db");
const bcrypt    = require("bcryptjs");

const PUBLIC_KEYS = ["id", "username", "email", "avatar_url", "bio", "elo_rating", "created_at"];

const User = {
  publicFields(user) {
    return Object.fromEntries(PUBLIC_KEYS.filter(key => user[key] !== undefined).map(key => [key, user[key]]));
  },

  hashPassword(password) {
    return bcrypt.hash(password, 12);
  },

  async create({ username, email, password }) {
    const hashedPassword = await this.hashPassword(password);
    const result = await query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, avatar_url, bio, elo_rating, created_at`,
      [username, email, hashedPassword]
    );
    return result.rows[0];
  },

  async findByEmail(email) {
    const result = await query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await query(
      `SELECT id, username, email, avatar_url, bio, elo_rating, created_at
       FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByUsername(username) {
    const result = await query(
      `SELECT id, username, email, avatar_url, bio, elo_rating, created_at
       FROM users WHERE username = $1`,
      [username]
    );
    return result.rows[0] || null;
  },

  async validatePassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  },

  // تحديث الملف الشخصي (Bio / Avatar) — Phase 1: Profile Page + Avatar Upload
  async updateProfile(id, { bio }) {
    const result = await query(
      `UPDATE users SET bio=$2 WHERE id=$1
       RETURNING id, username, email, avatar_url, bio, elo_rating, created_at`,
      [id, bio ?? null]
    );
    return result.rows[0] || null;
  },

  async replaceAvatar(id, avatarUrl) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT avatar_url FROM users WHERE id=$1 FOR UPDATE", [id]);
      if (current.rowCount !== 1) { await client.query("ROLLBACK"); return null; }
      const updated = await client.query(
        `UPDATE users SET avatar_url=$2 WHERE id=$1
         RETURNING id, username, email, avatar_url, bio, elo_rating, created_at`,
        [id, avatarUrl]
      );
      if (updated.rowCount !== 1) throw new Error("Avatar update affected an unexpected number of rows");
      await client.query("COMMIT");
      return { user: updated.rows[0], previousAvatarUrl: current.rows[0].avatar_url };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw error;
    } finally { client.release(); }
  },

  async invalidateSessions(id) {
    const result = await query(
      `UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING session_version`,
      [id]
    );
    if (result.rowCount !== 1) throw new Error("Session invalidation failed");
    return result.rows[0].session_version;
  },

  // تحديث ELO بعد انتهاء لعبة — أساس Phase 3
  async updateElo(id, newElo) {
    const result = await query(
      `UPDATE users SET elo_rating = $2 WHERE id = $1
       RETURNING id, username, elo_rating`,
      [id, newElo]
    );
    return result.rows[0] || null;
  },

  // لوحة صدارة ELO — يفيد صفحة Leaderboard لاحقًا
  async getTopByElo(limit = 10) {
    const result = await query(
      `SELECT id, username, avatar_url, elo_rating
       FROM users ORDER BY elo_rating DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  },
};

module.exports = User;
