// ============================================================
// routes/game.js — Game Info Routes
// GET /api/game/active       — الألعاب النشطة حالياً
// GET /api/game/stats        — إحصائيات عامة
// GET /api/game/:id          — بيانات لعبة معينة (Replay)
// GET /api/game/:id/moves    — كل حركات لعبة معينة بالترتيب (Replay)
// ============================================================
const express = require("express");
const { query } = require("../config/db");
const logger    = require("../config/logger");
const Game      = require("../models/Game");
const Move      = require("../models/Move");

const router = express.Router();

// ── Active Games Count ─────────────────────────────────────
router.get("/active", (req, res) => {
  // يُعاد من Socket.io State
  const io = req.app.get("io");
  const rooms = io ? io.sockets.adapter.rooms.size : 0;
  res.json({ activeGames: rooms });
});

// ── General Stats ──────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*)::int as total_games,
        COUNT(DISTINCT user_id)::int as total_players,
        AVG(moves)::int as avg_moves,
        MIN(CASE WHEN winner = true THEN moves END) as record_moves
      FROM scores
    `);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Game stats error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── Game Info (Replay) ──────────────────────────────────────
router.get("/:id(\\d+)", async (req, res) => {
  try {
    const game = await Game.findById(req.params.id);
    if (!game) return res.status(404).json({ error: "Game not found" });
    res.json({ game });
  } catch (err) {
    logger.error(`Get game error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch game" });
  }
});

// ── Game Moves (Replay) ──────────────────────────────────────
router.get("/:id(\\d+)/moves", async (req, res) => {
  try {
    const game = await Game.findById(req.params.id);
    if (!game) return res.status(404).json({ error: "Game not found" });
    const moves = await Move.getByGameId(req.params.id);
    res.json({ game, moves });
  } catch (err) {
    logger.error(`Get moves error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch moves" });
  }
});

module.exports = router;
