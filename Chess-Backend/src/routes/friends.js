// ============================================================
// routes/friends.js — Friend System
// POST   /api/friends/request        — إرسال طلب صداقة (بالـ username)
// GET    /api/friends                — قائمة الأصدقاء
// GET    /api/friends/requests       — الطلبات الواردة
// POST   /api/friends/:id/accept
// POST   /api/friends/:id/decline
// DELETE /api/friends/:id            — إلغاء صداقة / سحب طلب
// ============================================================
const express = require("express");
const { body, validationResult } = require("express-validator");
const Friendship = require("../models/Friendship");
const { authMiddleware } = require("../middleware/auth");
const logger = require("../config/logger");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const friends = await Friendship.listFriends(req.user.id);
    res.json({ friends });
  } catch (err) {
    logger.error(`List friends error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch friends" });
  }
});

router.get("/requests", authMiddleware, async (req, res) => {
  try {
    const requests = await Friendship.listIncomingRequests(req.user.id);
    res.json({ requests });
  } catch (err) {
    logger.error(`List requests error: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

router.post("/request", authMiddleware, [
  body("username").trim().notEmpty().withMessage("Username is required"),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid request" });

    const result = await Friendship.sendRequest(req.user.id, req.body.username);
    if (result.error) return res.status(400).json({ error: result.error });

    logger.info(`Friend request: ${req.user.username} -> ${req.body.username}`);
    res.status(201).json({ friendship: result.friendship });
  } catch (err) {
    logger.error(`Send request error: ${err.message}`);
    res.status(500).json({ error: "Failed to send request" });
  }
});

router.post("/:id/accept", authMiddleware, async (req, res) => {
  try {
    const result = await Friendship.respond(req.params.id, req.user.id, true);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ friendship: result.friendship });
  } catch (err) {
    logger.error(`Accept request error: ${err.message}`);
    res.status(500).json({ error: "Failed to accept request" });
  }
});

router.post("/:id/decline", authMiddleware, async (req, res) => {
  try {
    const result = await Friendship.respond(req.params.id, req.user.id, false);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ declined: true });
  } catch (err) {
    logger.error(`Decline request error: ${err.message}`);
    res.status(500).json({ error: "Failed to decline request" });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const ok = await Friendship.remove(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ error: "Friendship not found" });
    res.json({ removed: true });
  } catch (err) {
    logger.error(`Remove friend error: ${err.message}`);
    res.status(500).json({ error: "Failed to remove friend" });
  }
});

module.exports = router;
