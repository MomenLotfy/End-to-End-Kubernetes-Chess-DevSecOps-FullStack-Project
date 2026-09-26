const express = require("express");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const Game = require("../models/Game");
const AuthToken = require("../models/AuthToken");
const GameTransaction = callback => Game.runInTransaction(callback);
const { authMiddleware } = require("../middleware/auth");
const { upload, inspectAndStoreAvatar, uploadErrorHandler } = require("../middleware/upload");
const { managedAvatarFilename, deleteAvatar } = require("../services/avatarStore");
const { sendAccountLink } = require("../services/mail");
const {
  REFRESH_COOKIE, signAccessToken, setAccessCookie, setRefreshCookie, clearAuthCookies,
} = require("../services/tokens");
const logger = require("../config/logger");

const router = express.Router();
const validationFailure = res => res.status(400).json({ error: "Invalid request" });
const DUMMY_PASSWORD_HASH = "$2a$12$6250ZAToqFIWsZEzPEUYvueERVyn/GzecXv/J0aiGdO4/mTg0Ou1.";

async function establishSession(res, user) {
  const refresh = await AuthToken.issueRefreshToken(user.id);
  setAccessCookie(res, signAccessToken(user));
  setRefreshCookie(res, refresh);
}

router.post("/register", [
  body("username").trim().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
  body("email").isEmail().normalizeEmail(),
  body("password").isLength({ min: 10, max: 128 }),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return validationFailure(res);
  try {
    const { username, email, password } = req.body;
    if (await User.findByEmail(email) || await User.findByUsername(username)) {
      return res.status(409).json({ error: "Unable to create account" });
    }
    const user = await User.create({ username, email, password });
    const token = await AuthToken.issueAccountToken(user.id, "email_verification", 24 * 3600000);
    await sendAccountLink({
      to: user.email,
      subject: "Verify your Chess account",
      path: `/verify-email?token=${encodeURIComponent(token)}`,
      text: "Verify your account using this one-time link. It expires in 24 hours.",
    });
    logger.info(`New user registered: ${user.id}`);
    res.status(201).json({ message: "Check your email to verify your account" });
  } catch (err) {
    logger.error("Registration failed", { error: err.stack });
    res.status(500).json({ error: "Unable to create account" });
  }
});

router.post("/verify-email", [body("token").isString().isLength({ min: 20, max: 200 })], async (req, res) => {
  if (!validationResult(req).isEmpty()) return validationFailure(res);
  try {
    const valid = await AuthToken.consumeAccountToken(req.body.token, "email_verification", async (client, userId, tokenId) => {
      const result = await client.query(
        "UPDATE users SET email_verified_at=COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id=$1", [userId]
      );
      if (result.rowCount !== 1) throw new Error("Verification user missing");
      await client.query(
        `UPDATE account_tokens SET consumed_at=CURRENT_TIMESTAMP
         WHERE user_id=$1 AND purpose='email_verification' AND id<>$2 AND consumed_at IS NULL`,
        [userId, tokenId]
      );
    });
    if (!valid) return res.status(400).json({ error: "Invalid or expired token" });
    res.json({ message: "Email verified" });
  } catch (err) {
    logger.error("Email verification failed", { error: err.stack });
    res.status(500).json({ error: "Unable to verify email" });
  }
});

router.post("/resend-verification", [body("email").isEmail().normalizeEmail()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return validationFailure(res);
  const response = { message: "If verification is required, an email has been sent" };
  try {
    const user = await User.findByEmail(req.body.email);
    if (user && !user.email_verified_at) {
      const token = await AuthToken.issueAccountToken(user.id, "email_verification", 24 * 3600000);
      await sendAccountLink({
        to: user.email,
        subject: "Verify your Chess account",
        path: `/verify-email?token=${encodeURIComponent(token)}`,
        text: "Verify your account using this one-time link. It expires in 24 hours.",
      });
    }
  } catch (err) { logger.error("Verification resend failed", { error: err.stack }); }
  res.json(response);
});

router.post("/login", [body("email").isEmail().normalizeEmail(), body("password").isString()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(401).json({ error: "Invalid credentials" });
  try {
    const user = await User.findByEmail(req.body.email);
    const valid = await User.validatePassword(req.body.password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !valid || !user.email_verified_at) return res.status(401).json({ error: "Invalid credentials" });
    await establishSession(res, user);
    logger.info(`User logged in: ${user.id}`);
    res.json({ user: User.publicFields(user) });
  } catch (err) {
    logger.error("Login failed", { error: err.stack });
    res.status(500).json({ error: "Unable to sign in" });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) return res.status(401).json({ error: "Authentication required" });
    const rotated = await AuthToken.rotateRefreshToken(raw);
    if (!rotated || !rotated.user.email_verified_at) {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Authentication required" });
    }
    setAccessCookie(res, signAccessToken(rotated.user));
    setRefreshCookie(res, rotated.raw);
    res.json({ user: User.publicFields(rotated.user) });
  } catch (err) {
    logger.error("Refresh failed", { error: err.stack });
    clearAuthCookies(res);
    res.status(401).json({ error: "Authentication required" });
  }
});

router.post("/logout", authMiddleware, async (req, res) => {
  try {
    await GameTransaction(async client => {
      const invalidated = await client.query(
        "UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING id",
        [req.user.id]
      );
      if (invalidated.rowCount !== 1) throw new Error("Session invalidation failed");
      await AuthToken.revokeAllForUser(req.user.id, client);
    });
    clearAuthCookies(res);
    res.status(204).end();
  } catch (err) {
    logger.error("Logout session invalidation failed", { error: err.stack });
    res.status(500).json({ error: "Unable to sign out" });
  }
});

router.post("/forgot-password", [body("email").isEmail().normalizeEmail()], async (req, res) => {
  if (!validationResult(req).isEmpty()) return validationFailure(res);
  const generic = { message: "If that account exists, a reset email has been sent" };
  try {
    const user = await User.findByEmail(req.body.email);
    if (user) {
      const token = await AuthToken.issueAccountToken(user.id, "password_reset", 60 * 60000);
      await sendAccountLink({
        to: user.email,
        subject: "Reset your Chess password",
        path: `/reset-password?token=${encodeURIComponent(token)}`,
        text: "Reset your password using this one-time link. It expires in one hour.",
      });
    }
  } catch (err) { logger.error("Password reset request failed", { error: err.stack }); }
  res.json(generic);
});

router.post("/reset-password", [
  body("token").isString().isLength({ min: 20, max: 200 }),
  body("password").isLength({ min: 10, max: 128 }),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return validationFailure(res);
  try {
    const hash = await User.hashPassword(req.body.password);
    const valid = await AuthToken.consumeAccountToken(req.body.token, "password_reset", async (client, userId, tokenId) => {
      const updated = await client.query(
        "UPDATE users SET password_hash=$2, session_version=session_version+1 WHERE id=$1",
        [userId, hash]
      );
      if (updated.rowCount !== 1) throw new Error("Password reset user missing");
      await client.query("UPDATE refresh_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
      await client.query(
        `UPDATE account_tokens SET consumed_at=CURRENT_TIMESTAMP
         WHERE user_id=$1 AND purpose='password_reset' AND id<>$2 AND consumed_at IS NULL`, [userId, tokenId]
      );
    });
    if (!valid) return res.status(400).json({ error: "Invalid or expired token" });
    clearAuthCookies(res);
    res.json({ message: "Password reset complete" });
  } catch (err) {
    logger.error("Password reset failed", { error: err.stack });
    res.status(500).json({ error: "Unable to reset password" });
  }
});

router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "Resource not found" });
    res.json(user);
  } catch (err) { logger.error("Profile read failed", { error: err.stack }); res.status(500).json({ error: "Unable to load profile" }); }
});

router.patch("/profile", authMiddleware, [
  body("bio").isString().isLength({ max: 160 }),
  body().custom(value => Object.keys(value).every(key => key === "bio")),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return validationFailure(res);
  try {
    const user = await User.updateProfile(req.user.id, req.body);
    if (!user) return res.status(404).json({ error: "Resource not found" });
    res.json({ user });
  } catch (err) { logger.error("Profile update failed", { error: err.stack }); res.status(500).json({ error: "Unable to update profile" }); }
});

router.post("/avatar", authMiddleware, upload.single("avatar"), uploadErrorHandler, inspectAndStoreAvatar, async (req, res) => {
  try {
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    const replacement = await User.replaceAvatar(req.user.id, avatarUrl);
    if (!replacement) throw new Error("Avatar user missing");
    const oldName = managedAvatarFilename(replacement.previousAvatarUrl);
    if (oldName && !(await deleteAvatar(oldName))) {
      logger.warn("Old avatar delete failed (orphan — see S3 runbook)");
    }
    res.json({ user: replacement.user });
  } catch (err) {
    if (req.file?.filename) await deleteAvatar(req.file.filename).catch(() => false);
    logger.error("Avatar update failed", { error: err.stack });
    res.status(500).json({ error: "Unable to update avatar" });
  }
});

module.exports = router;
