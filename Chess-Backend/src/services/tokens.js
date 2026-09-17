const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { requireJwtSecret } = require("../config/security");

const ACCESS_COOKIE = "chess_access";
const REFRESH_COOKIE = "chess_refresh";
const ACCESS_TTL = process.env.JWT_ACCESS_EXPIRES || "15m";
const REFRESH_MAX_AGE_MS = Number(process.env.REFRESH_TOKEN_DAYS || 30) * 86400000;

const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, sessionVersion: user.session_version, type: "access" },
    requireJwtSecret(),
    { expiresIn: ACCESS_TTL, issuer: "chess-api", audience: "chess-web" }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, requireJwtSecret(), {
    issuer: "chess-api",
    audience: "chess-web",
  });
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    ...(maxAge ? { maxAge } : {}),
  };
}

function setAccessCookie(res, token) {
  res.cookie(ACCESS_COOKIE, token, cookieOptions(15 * 60 * 1000));
}
function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(REFRESH_MAX_AGE_MS));
}
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions());
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

module.exports = {
  ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_MAX_AGE_MS,
  hashToken, randomToken, signAccessToken, verifyAccessToken,
  setAccessCookie, setRefreshCookie, clearAuthCookies,
};
