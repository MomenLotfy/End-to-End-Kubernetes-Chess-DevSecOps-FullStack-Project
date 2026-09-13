// ============================================================
// routes/leaderboard.js — Leaderboard Routes
// GET  /api/leaderboard          — أعلى 10 نتائج
// POST /api/leaderboard/save     — حفظ نتيجة لعبة
// GET  /api/leaderboard/me       — إحصائيات المستخدم
// GET  /api/leaderboard/history  — تاريخ ألعابي
// ============================================================
const express = require("express");
const { body, validationResult } = require("express-validator");
const Score       = require("../models/Score");
const Game        = require("../models/Game");
const Move        = require("../models/Move");
const Achievement = require("../models/Achievement");
const User        = require("../models/User");
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const logger  = require("../config/logger");

const router = express.Router();

// ── Top Scores ─────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 10, 50);
    const scores = await Score.getTopScores(limit);
    res.json({ scores, count: scores.length });
  } catch (err) {
    logger.error(`Leaderboard error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ── Top ELO (ELO Rating System) ─────────────────────────────
router.get("/elo", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const players = await User.getTopByElo(limit);
    res.json({ players, count: players.length });
  } catch (err) {
    logger.error(`ELO leaderboard error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch ELO leaderboard" });
  }
});

// ── Save Game Result ────────────────────────────────────────
router.post("/save", authMiddleware, [
  body("moves").isInt({ min: 1 }).withMessage("Invalid moves count"),
  body("duration").isInt({ min: 1 }).withMessage("Invalid duration"),
  body("winner").isBoolean().withMessage("Winner must be boolean"),
  // moveHistory اختياري: لو الفرونت بعت تفاصيل الحركات هنخزّنها لـ Replay مستقبلاً
  body("moveHistory").optional().isArray().withMessage("moveHistory must be an array"),
  body("mode").optional().isIn(["local", "ai"]).withMessage("Invalid mode"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { moves, duration, winner, moveHistory, mode } = req.body;
    const gameMode = mode || "local";

    // لو اتبعت تفاصيل الحركات → نسجّل لعبة كاملة في games/moves
    let gameId = null;
    if (Array.isArray(moveHistory) && moveHistory.length > 0) {
      const game = await Game.create({
        roomId:        null,
        whiteUserId:   req.user.id,
        whiteUsername: req.user.username,
        gameMode,
      });
      gameId = game.id;

      let n = 1;
      for (const m of moveHistory) {
        await Move.record({
          gameId,
          moveNumber:    n++,
          playerColor:   m.color,
          from:          m.from,
          to:            m.to,
          piece:         m.piece,
          capturedPiece: m.captured,
          san:           m.san,
          fenAfter:      m.fenAfter,
        });
      }

      await Game.finishById(gameId, { result: winner ? "checkmate" : "resign", winnerColor: winner ? moveHistory[moveHistory.length - 1]?.color : null });
    }

    const score = await Score.save({
      userId:   req.user.id,
      username: req.user.username,
      moves,
      duration,
      winner,
      gameMode: gameMode,
      gameId,
    });

    logger.info(`Score saved for ${req.user.username}: ${moves} moves`);

    // فحص الأوسمة بعد كل لعبة (Achievements/Badges)
    const newAchievements = await Achievement.checkAndAward(req.user.id, { moves, winner, moveHistory });

    res.status(201).json({ score, newAchievements });

  } catch (err) {
    logger.error(`Save score error: ${err.message}`);
    res.status(500).json({ error: "Failed to save score" });
  }
});

// ── My Stats ───────────────────────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const stats = await Score.getUserStats(req.user.id);
    res.json(stats);
  } catch (err) {
    logger.error(`User stats error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── My History ─────────────────────────────────────────────
router.get("/history", authMiddleware, async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit) || 10, 50);
    const history = await Score.getUserHistory(req.user.id, limit);
    res.json({ history, count: history.length });
  } catch (err) {
    logger.error(`User history error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// ── My Achievements ──────────────────────────────────────────
router.get("/achievements", authMiddleware, async (req, res) => {
  try {
    const achievements = await Achievement.getAllWithStatus(req.user.id);
    res.json({ achievements });
  } catch (err) {
    logger.error(`Achievements error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch achievements" });
  }
});

module.exports = router;
