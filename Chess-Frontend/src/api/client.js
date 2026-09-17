export const API = process.env.REACT_APP_API_URL || "";

async function request(path, { method = "GET", body, retry = true } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 && retry && path !== "/api/auth/login" && path !== "/api/auth/refresh") {
    const refreshed = await fetch(`${API}/api/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) return request(path, { method, body, retry: false });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export const login = (email, password) => request("/api/auth/login", { method: "POST", body: { email, password } });
export const register = (username, email, password) => request("/api/auth/register", { method: "POST", body: { username, email, password } });
export const logout = () => request("/api/auth/logout", { method: "POST", retry: false });
export const refreshSession = () => request("/api/auth/refresh", { method: "POST", retry: false });
export const verifyEmail = token => request("/api/auth/verify-email", { method: "POST", body: { token } });
export const forgotPassword = email => request("/api/auth/forgot-password", { method: "POST", body: { email } });
export const resetPassword = (token, password) => request("/api/auth/reset-password", { method: "POST", body: { token, password } });
export const getProfile = () => request("/api/auth/profile");
export const updateProfile = (_session, { bio, avatarUrl }) => request("/api/auth/profile", { method: "PATCH", body: { bio, avatarUrl } });

export const uploadAvatar = async (_session, file) => {
  const form = new FormData();
  form.append("avatar", file);
  const response = await fetch(`${API}/api/auth/avatar`, { method: "POST", credentials: "include", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Upload failed");
  return data;
};

export const getLeaderboard = () => request("/api/leaderboard");
export const getEloLeaderboard = () => request("/api/leaderboard/elo");
export const getMyStats = () => request("/api/leaderboard/me");
export const getMyHistory = () => request("/api/leaderboard/history");
export const getMyAchievements = () => request("/api/leaderboard/achievements");
export const saveScore = (session, { moves, duration, winner, moveHistory, mode }) => {
  if (!session) return Promise.resolve(null);
  return request("/api/leaderboard/save", { method: "POST", body: { moves, duration, winner, moveHistory, mode } })
    .catch(err => { console.warn("Score save failed:", err.message); return null; });
};
export const getGame = id => request(`/api/game/${id}`);
export const getGameMoves = id => request(`/api/game/${id}/moves`);
export const getFriends = () => request("/api/friends");
export const getFriendRequests = () => request("/api/friends/requests");
export const sendFriendRequest = (_session, username) => request("/api/friends/request", { method: "POST", body: { username } });
export const acceptFriendRequest = (_session, id) => request(`/api/friends/${id}/accept`, { method: "POST" });
export const declineFriendRequest = (_session, id) => request(`/api/friends/${id}/decline`, { method: "POST" });
export const removeFriend = (_session, id) => request(`/api/friends/${id}`, { method: "DELETE" });
export const listTournaments = () => request("/api/tournaments");
export const getTournament = id => request(`/api/tournaments/${id}`);
export const createTournament = (_session, name, maxPlayers) => request("/api/tournaments", { method: "POST", body: { name, maxPlayers } });
export const joinTournament = (_session, id) => request(`/api/tournaments/${id}/join`, { method: "POST" });
export const startTournament = (_session, id) => request(`/api/tournaments/${id}/start`, { method: "POST" });
export const reportMatchResult = (_session, matchId, winnerId) => request(`/api/tournaments/matches/${matchId}/report`, { method: "POST", body: { winnerId } });
