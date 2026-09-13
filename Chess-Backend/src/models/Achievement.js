// ============================================================
// models/Achievement.js — Achievements / Badges
// ============================================================
const { query } = require("../config/db");

const Achievement = {

  async awardIfNew(userId, key) {
    const res = await query(
      `INSERT INTO user_achievements (user_id, achievement_key)
       VALUES ($1, $2) ON CONFLICT (user_id, achievement_key) DO NOTHING
       RETURNING achievement_key`,
      [userId, key]
    );
    return res.rows[0] ? key : null;
  },

  // كل الأوسمة (متاحة + المكتسبة) — لعرضها في صفحة البروفايل
  async getAllWithStatus(userId) {
    const res = await query(
      `SELECT a.key, a.name, a.description, a.icon, ua.earned_at
       FROM achievements a
       LEFT JOIN user_achievements ua ON ua.achievement_key = a.key AND ua.user_id = $1
       ORDER BY a.key`,
      [userId]
    );
    return res.rows;
  },

  // فحص شروط الأوسمة بعد كل لعبة، وإرجاع أي أوسمة جديدة اتكسبت
  async checkAndAward(userId, { moves, winner, moveHistory = [] }) {
    const newly = [];
    const tryAward = async (key) => {
      const k = await Achievement.awardIfNew(userId, key);
      if (k) newly.push(k);
    };

    await tryAward("first_game");

    if (winner) {
      const winsRes = await query(
        `SELECT COUNT(*)::int as wins FROM scores WHERE user_id = $1 AND winner = true`,
        [userId]
      );
      const wins = winsRes.rows[0].wins;
      if (wins >= 1)  await tryAward("first_win");
      if (wins >= 5)  await tryAward("wins_5");
      if (wins >= 10) await tryAward("wins_10");
      if (wins >= 25) await tryAward("wins_25");

      if (moves <= 15) await tryAward("quick_win");

      const winnerColor = moveHistory[moveHistory.length - 1]?.color;
      if (winnerColor && moveHistory.length > 0) {
        const lostAnyPiece = moveHistory.some(m => m.captured && m.captured[0] === winnerColor);
        if (!lostAnyPiece) await tryAward("flawless");

        const lostQueen = moveHistory.some(m => m.captured === winnerColor + "Q");
        if (lostQueen) await tryAward("comeback");
      }
    }

    if (moves >= 60) await tryAward("marathon");

    return newly;
  },
};

module.exports = Achievement;
