const crypto = require("crypto");
const { pool, query } = require("../config/db");
const { hashToken, randomToken, REFRESH_MAX_AGE_MS } = require("../services/tokens");

const AuthToken = {
  async issueAccountToken(userId, purpose, ttlMs) {
    const raw = randomToken();
    await query(
      `INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'))`,
      [userId, purpose, hashToken(raw), ttlMs]
    );
    return raw;
  },

  async consumeAccountToken(raw, purpose, callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT * FROM account_tokens
         WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
         FOR UPDATE`,
        [hashToken(raw), purpose]
      );
      if (found.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      await callback(client, found.rows[0].user_id, found.rows[0].id);
      const consumed = await client.query(
        "UPDATE account_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE id=$1 AND consumed_at IS NULL",
        [found.rows[0].id]
      );
      if (consumed.rowCount !== 1) throw new Error("Account token was concurrently consumed");
      await client.query("COMMIT");
      return true;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally { client.release(); }
  },

  async issueRefreshToken(userId, familyId = crypto.randomUUID()) {
    const raw = randomToken();
    await query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'))`,
      [userId, familyId, hashToken(raw), REFRESH_MAX_AGE_MS]
    );
    return raw;
  },

  async rotateRefreshToken(raw) {
    const oldHash = hashToken(raw);
    const nextRaw = randomToken();
    const nextHash = hashToken(nextRaw);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE", [oldHash]);
      const old = found.rows[0];
      if (!old || old.expires_at <= new Date() || old.revoked_at) {
        await client.query("ROLLBACK");
        return null;
      }
      if (old.consumed_at) {
        await client.query("UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE family_id=$1 AND revoked_at IS NULL", [old.family_id]);
        await client.query("COMMIT");
        return null;
      }
      const used = await client.query(
        `UPDATE refresh_tokens SET consumed_at=CURRENT_TIMESTAMP, replaced_by_hash=$2
         WHERE id=$1 AND consumed_at IS NULL`, [old.id, nextHash]
      );
      if (used.rowCount !== 1) throw new Error("Refresh token rotation conflict");
      await client.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'))`,
        [old.user_id, old.family_id, nextHash, REFRESH_MAX_AGE_MS]
      );
      const user = await client.query(
        "SELECT id, username, email, email_verified_at, session_version FROM users WHERE id=$1", [old.user_id]
      );
      if (user.rowCount !== 1) throw new Error("Refresh token user is missing");
      await client.query("COMMIT");
      return { raw: nextRaw, user: user.rows[0] };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw err;
    } finally { client.release(); }
  },

  async revokeRefreshToken(raw) {
    const result = await query(
      "UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1 AND revoked_at IS NULL",
      [hashToken(raw)]
    );
    return result.rowCount === 1;
  },

  async revokeAllForUser(userId, client = null) {
    return (client || { query }).query(
      "UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL",
      [userId]
    );
  },
};
module.exports = AuthToken;
