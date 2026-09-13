// ============================================================
// routes/auth.js — Authentication Routes
// POST  /api/auth/register
// POST  /api/auth/login
// GET   /api/auth/profile
// PATCH /api/auth/profile
// POST  /api/auth/avatar
// ============================================================
const express = require("express");
const jwt     = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const User    = require("../models/User");
const { authMiddleware } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const logger  = require("../config/logger");

const router = express.Router();
const JWT_SECRET  = process.env.JWT_SECRET  || "chess-secret-key";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

// ── Register ──────────────────────────────────────────────
router.post("/register", [
  body("username")
    .trim()
    .isLength({ min: 3, max: 20 }).withMessage("Username must be 3-20 characters")
    .matches(/^[a-zA-Z0-9_]+$/).withMessage("Username can only contain letters, numbers, underscore"),
  body("email")
    .isEmail().withMessage("Invalid email address")
    .normalizeEmail(),
  body("password")
    .isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, password } = req.body;

    // فحص التكرار
    const existingEmail = await User.findByEmail(email);
    if (existingEmail) return res.status(409).json({ error: "Email already registered" });

    const existingUsername = await User.findByUsername(username);
    if (existingUsername) return res.status(409).json({ error: "Username already taken" });

    const user = await User.create({ username, email, password });

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    logger.info(`New user registered: ${username}`);
    res.status(201).json({ token, user });

  } catch (err) {
    logger.error(`Register error: ${err.message}`);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── Login ─────────────────────────────────────────────────
router.post("/login", [
  body("email").isEmail().normalizeEmail(),
  body("password").notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findByEmail(email);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await User.validatePassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    logger.info(`User logged in: ${user.username}`);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email },
    });

  } catch (err) {
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Get Profile ───────────────────────────────────────────
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    logger.error(`Profile error: ${err.message}`);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

// ── Update Profile (Bio / Avatar) ───────────────────────────
// ملاحظة: ده بيستقبل رابط صورة جاهز (avatarUrl)، مش رفع ملف —
// رفع الملف نفسه (multer/S3) جزء من Avatar Upload في Phase 2.
router.patch("/profile", authMiddleware, [
  body("bio").optional().isLength({ max: 160 }).withMessage("Bio must be 160 characters or less"),
  body("avatarUrl").optional().isURL().withMessage("avatarUrl must be a valid URL"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bio, avatarUrl } = req.body;
    const user = await User.updateProfile(req.user.id, { bio, avatarUrl });
    if (!user) return res.status(404).json({ error: "User not found" });

    logger.info(`Profile updated: ${user.username}`);
    res.json({ user });

  } catch (err) {
    logger.error(`Update profile error: ${err.message}`);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ── Upload Avatar ────────────────────────────────────────────
router.post("/avatar", authMiddleware, (req, res) => {
  upload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    try {
      const avatarUrl = `${req.protocol}://${req.get("host")}/uploads/avatars/${req.file.filename}`;
      const user = await User.updateProfile(req.user.id, { avatarUrl });
      logger.info(`Avatar updated: ${user.username}`);
      res.json({ user });
    } catch (e) {
      logger.error(`Avatar upload error: ${e.message}`);
      res.status(500).json({ error: "Failed to save avatar" });
    }
  });
});

module.exports = router;
