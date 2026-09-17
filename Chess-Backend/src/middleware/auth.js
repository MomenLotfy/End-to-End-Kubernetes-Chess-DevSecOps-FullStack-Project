const db = require("../config/db");
const logger = require("../config/logger");
const { ACCESS_COOKIE, verifyAccessToken } = require("../services/tokens");

async function activeSession(payload) {
  if (!Number.isInteger(payload.id) || !Number.isInteger(payload.sessionVersion)) return false;
  const result = await db.query("SELECT session_version, email_verified_at FROM users WHERE id=$1", [payload.id]);
  return result.rowCount === 1
    && result.rows[0].email_verified_at
    && result.rows[0].session_version === payload.sessionVersion;
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    const payload = verifyAccessToken(token);
    if (!await activeSession(payload)) return res.status(401).json({ error: "Authentication required" });
    req.user = payload;
    next();
  } catch (error) {
    logger.warn(`Access token rejected: ${error.name}`);
    return res.status(401).json({ error: "Authentication required" });
  }
}

async function optionalAuth(req, res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    if (await activeSession(payload)) req.user = payload;
  } catch (error) { logger.warn(`Optional access token rejected: ${error.name}`); }
  next();
}

module.exports = { authMiddleware, optionalAuth, activeSession };
