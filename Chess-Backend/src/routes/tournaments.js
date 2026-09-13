// ============================================================
// routes/tournaments.js — Tournament Mode
// GET    /api/tournaments              — البطولات المفتوحة/الجارية
// POST   /api/tournaments              — إنشاء بطولة جديدة
// GET    /api/tournaments/:id          — تفاصيل + اللاعبين + الماتشات
// POST   /api/tournaments/:id/join
// POST   /api/tournaments/:id/start
// POST   /api/tournaments/matches/:matchId/report   { winnerId }
// ============================================================
const express = require("express");
const { body, validationResult } = require("express-validator");
const Tournament = require("../models/Tournament");
const { authMiddleware } = require("../middleware/auth");
const logger = require("../config/logger");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const tournaments = await Tournament.listOpen();
    res.json({ tournaments });
  } catch (err) {
    logger.error(`List tournaments error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch tournaments" });
  }
});

router.post("/", authMiddleware, [
  body("name").trim().isLength({ min: 3, max: 80 }).withMessage("Name must be 3-80 characters"),
  body("maxPlayers").isIn([4, 8, 16]).withMessage("maxPlayers must be 4, 8, or 16"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const tournament = await Tournament.create(req.user.id, req.body.name, req.body.maxPlayers);
    logger.info(`Tournament created: ${tournament.name} by ${req.user.username}`);
    res.status(201).json({ tournament });
  } catch (err) {
    logger.error(`Create tournament error: ${err.message}`);
    res.status(500).json({ error: "Failed to create tournament" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const tournament = await Tournament.getById(req.params.id);
    if (!tournament) return res.status(404).json({ error: "Tournament not found" });
    const [players, matches] = await Promise.all([
      Tournament.getPlayers(req.params.id),
      Tournament.getMatches(req.params.id),
    ]);
    res.json({ tournament, players, matches });
  } catch (err) {
    logger.error(`Get tournament error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch tournament" });
  }
});

router.post("/:id/join", authMiddleware, async (req, res) => {
  try {
    const result = await Tournament.join(req.params.id, req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error(`Join tournament error: ${err.message}`);
    res.status(500).json({ error: "Failed to join tournament" });
  }
});

router.post("/:id/start", authMiddleware, async (req, res) => {
  try {
    const result = await Tournament.start(req.params.id, req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error(`Start tournament error: ${err.message}`);
    res.status(500).json({ error: "Failed to start tournament" });
  }
});

router.post("/matches/:matchId/report", authMiddleware, [
  body("winnerId").isInt().withMessage("winnerId is required"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const result = await Tournament.reportResult(req.params.matchId, req.user.id, req.body.winnerId);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    logger.error(`Report match error: ${err.message}`);
    res.status(500).json({ error: "Failed to report result" });
  }
});

module.exports = router;
