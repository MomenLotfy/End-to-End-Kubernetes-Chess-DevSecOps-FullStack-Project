// ============================================================
// api/client.js — كل نداءات الـ Backend في مكان واحد
// ============================================================
export const API = process.env.REACT_APP_API_URL || "http://localhost:5000";

async function request(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errors?.[0]?.msg || data.error || "Request failed");
  return data;
}

// ── Auth ─────────────────────────────────────────────────
export const login    = (email, password) => request("/api/auth/login", { method: "POST", body: { email, password } });
export const register = (username, email, password) => request("/api/auth/register", { method: "POST", body: { username, email, password } });
export const getProfile    = (token) => request("/api/auth/profile", { token });
export const updateProfile = (token, { bio, avatarUrl }) => request("/api/auth/profile", { method: "PATCH", token, body: { bio, avatarUrl } });

// رفع صورة أفاتار (multipart/form-data — مش JSON زي باقي النداءات)
export const uploadAvatar = async (token, file) => {
  const form = new FormData();
  form.append("avatar", file);
  const res = await fetch(`${API}/api/auth/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
};

// ── Leaderboard ──────────────────────────────────────────
export const getLeaderboard = () => request("/api/leaderboard");
export const getEloLeaderboard = () => request("/api/leaderboard/elo");
export const getMyStats     = (token) => request("/api/leaderboard/me", { token });
export const getMyHistory   = (token) => request("/api/leaderboard/history", { token });
export const getMyAchievements = (token) => request("/api/leaderboard/achievements", { token });

export const saveScore = (token, { moves, duration, winner, moveHistory, mode }) => {
  if (!token) return Promise.resolve(null);
  return request("/api/leaderboard/save", {
    method: "POST",
    token,
    body: { moves, duration, winner, moveHistory, mode },
  }).catch(err => { console.warn("Score save failed:", err.message); return null; });
};

// ── Game / Replay ────────────────────────────────────────
export const getGame      = (id) => request(`/api/game/${id}`);
export const getGameMoves = (id) => request(`/api/game/${id}/moves`);

// ── Friends ──────────────────────────────────────────────
export const getFriends         = (token) => request("/api/friends", { token });
export const getFriendRequests  = (token) => request("/api/friends/requests", { token });
export const sendFriendRequest  = (token, username) => request("/api/friends/request", { method: "POST", token, body: { username } });
export const acceptFriendRequest  = (token, id) => request(`/api/friends/${id}/accept`, { method: "POST", token });
export const declineFriendRequest = (token, id) => request(`/api/friends/${id}/decline`, { method: "POST", token });
export const removeFriend         = (token, id) => request(`/api/friends/${id}`, { method: "DELETE", token });

// ── Tournaments ──────────────────────────────────────────
export const listTournaments  = () => request("/api/tournaments");
export const getTournament    = (id) => request(`/api/tournaments/${id}`);
export const createTournament = (token, name, maxPlayers) => request("/api/tournaments", { method: "POST", token, body: { name, maxPlayers } });
export const joinTournament   = (token, id) => request(`/api/tournaments/${id}/join`, { method: "POST", token });
export const startTournament  = (token, id) => request(`/api/tournaments/${id}/start`, { method: "POST", token });
export const reportMatchResult = (token, matchId, winnerId) => request(`/api/tournaments/matches/${matchId}/report`, { method: "POST", token, body: { winnerId } });
