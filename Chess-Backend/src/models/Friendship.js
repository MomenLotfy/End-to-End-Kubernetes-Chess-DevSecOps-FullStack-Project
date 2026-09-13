// ============================================================
// models/Friendship.js — Friend System
// ============================================================
const { query } = require("../config/db");

const Friendship = {

  // إرسال طلب صداقة (بالـ username)
  async sendRequest(requesterId, addresseeUsername) {
    const userRes = await query("SELECT id, username FROM users WHERE username = $1", [addresseeUsername]);
    const addressee = userRes.rows[0];
    if (!addressee) return { error: "User not found" };
    if (addressee.id === requesterId) return { error: "Can't add yourself" };

    // فيه علاقة قائمة بالفعل (بأي اتجاه)؟
    const existing = await query(
      `SELECT * FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [requesterId, addressee.id]
    );
    if (existing.rows[0]) return { error: existing.rows[0].status === "accepted" ? "Already friends" : "Request already pending" };

    const res = await query(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending') RETURNING *`,
      [requesterId, addressee.id]
    );
    return { friendship: res.rows[0] };
  },

  // قائمة الأصدقاء المقبولين (بمعلومات الطرف التاني)
  async listFriends(userId) {
    const res = await query(
      `SELECT f.id AS friendship_id, u.id, u.username, u.avatar_url, u.elo_rating
       FROM friendships f
       JOIN users u ON u.id = (CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END)
       WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
       ORDER BY u.username`,
      [userId]
    );
    return res.rows;
  },

  // طلبات واردة لسه معلقة
  async listIncomingRequests(userId) {
    const res = await query(
      `SELECT f.id AS friendship_id, u.id, u.username, u.avatar_url, u.elo_rating, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.status = 'pending' AND f.addressee_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    );
    return res.rows;
  },

  // قبول / رفض طلب — لازم المستخدم يكون هو الـ addressee
  async respond(friendshipId, userId, accept) {
    const check = await query("SELECT * FROM friendships WHERE id = $1 AND addressee_id = $2", [friendshipId, userId]);
    if (!check.rows[0]) return { error: "Request not found" };

    if (accept) {
      const res = await query("UPDATE friendships SET status = 'accepted' WHERE id = $1 RETURNING *", [friendshipId]);
      return { friendship: res.rows[0] };
    }
    await query("DELETE FROM friendships WHERE id = $1", [friendshipId]);
    return { declined: true };
  },

  // إلغاء صداقة أو سحب طلب مرسل
  async remove(friendshipId, userId) {
    const res = await query(
      `DELETE FROM friendships WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2) RETURNING id`,
      [friendshipId, userId]
    );
    return !!res.rows[0];
  },
};

module.exports = Friendship;
