const express = require("express");
const Score = require("../models/Score");
const Achievement = require("../models/Achievement");
const User = require("../models/User");
const { authMiddleware } = require("../middleware/auth");
const logger = require("../config/logger");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
    const scores = await Score.getTopScores(limit);
    res.json({ scores, count: scores.length });
  } catch (error) {
    logger.error("Leaderboard read failed", { error: error.stack });
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

router.get("/elo", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
    const players = await User.getTopByElo(limit);
    res.json({ players, count: players.length });
  } catch (error) {
    logger.error("ELO leaderboard read failed", { error: error.stack });
    res.status(500).json({ error: "Failed to fetch ELO leaderboard" });
  }
});

// Scores, results, ELO and achievements are written only by the authoritative multiplayer
// finalization transaction. Batch result submission from a browser is intentionally rejected.
router.post("/save", authMiddleware, (_req, res) => {
  res.status(410).json({ error: "Client-reported game results are not accepted" });
});

router.get("/me", authMiddleware, async (req, res) => {
  try { res.json(await Score.getUserStats(req.user.id)); }
  catch (error) { logger.error("User stats read failed", { error: error.stack }); res.status(500).json({ error: "Failed to fetch stats" }); }
});

router.get("/history", authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
    const history = await Score.getUserHistory(req.user.id, limit);
    res.json({ history, count: history.length });
  } catch (error) { logger.error("User history read failed", { error: error.stack }); res.status(500).json({ error: "Failed to fetch history" }); }
});

router.get("/achievements", authMiddleware, async (req, res) => {
  try { res.json({ achievements: await Achievement.getAllWithStatus(req.user.id) }); }
  catch (error) { logger.error("Achievements read failed", { error: error.stack }); res.status(500).json({ error: "Failed to fetch achievements" }); }
});

module.exports = router;
