// ============================================================
// models/User.js — User Model (PostgreSQL)
// ============================================================
const { query } = require("../config/db");
const bcrypt    = require("bcryptjs");

const User = {

  async create({ username, email, password }) {
    const hashedPassword = await bcrypt.hash(password, 12);
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
  async updateProfile(id, { bio, avatarUrl }) {
    const result = await query(
      `UPDATE users
       SET bio        = COALESCE($2, bio),
           avatar_url = COALESCE($3, avatar_url)
       WHERE id = $1
       RETURNING id, username, email, avatar_url, bio, elo_rating, created_at`,
      [id, bio ?? null, avatarUrl ?? null]
    );
    return result.rows[0] || null;
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
