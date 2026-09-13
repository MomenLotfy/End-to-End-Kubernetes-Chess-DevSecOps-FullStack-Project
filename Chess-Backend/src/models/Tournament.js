// ============================================================
// models/Tournament.js — Tournament Mode (single elimination)
// ============================================================
const { query } = require("../config/db");

const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const Tournament = {

  async create(creatorId, name, maxPlayers) {
    const res = await query(
      `INSERT INTO tournaments (name, creator_id, max_players, status)
       VALUES ($1, $2, $3, 'open') RETURNING *`,
      [name, creatorId, maxPlayers]
    );
    // المنشئ بينضم تلقائي كأول لاعب
    await query(
      `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [res.rows[0].id, creatorId]
    );
    return res.rows[0];
  },

  async listOpen() {
    const res = await query(
      `SELECT t.*, COUNT(tp.id)::int AS player_count
       FROM tournaments t
       LEFT JOIN tournament_players tp ON tp.tournament_id = t.id
       WHERE t.status IN ('open', 'in_progress')
       GROUP BY t.id
       ORDER BY t.created_at DESC
       LIMIT 30`
    );
    return res.rows;
  },

  async getById(id) {
    const res = await query("SELECT * FROM tournaments WHERE id = $1", [id]);
    return res.rows[0] || null;
  },

  async getPlayers(tournamentId) {
    const res = await query(
      `SELECT u.id, u.username, u.avatar_url, u.elo_rating
       FROM tournament_players tp JOIN users u ON u.id = tp.user_id
       WHERE tp.tournament_id = $1 ORDER BY tp.joined_at`,
      [tournamentId]
    );
    return res.rows;
  },

  async getMatches(tournamentId) {
    const res = await query(
      `SELECT m.*, u1.username AS player1_name, u2.username AS player2_name, uw.username AS winner_name
       FROM tournament_matches m
       LEFT JOIN users u1 ON u1.id = m.player1_id
       LEFT JOIN users u2 ON u2.id = m.player2_id
       LEFT JOIN users uw ON uw.id = m.winner_id
       WHERE m.tournament_id = $1
       ORDER BY m.round, m.position`,
      [tournamentId]
    );
    return res.rows;
  },

  async join(tournamentId, userId) {
    const t = await this.getById(tournamentId);
    if (!t) return { error: "Tournament not found" };
    if (t.status !== "open") return { error: "Tournament already started" };
    const countRes = await query("SELECT COUNT(*)::int AS c FROM tournament_players WHERE tournament_id = $1", [tournamentId]);
    if (countRes.rows[0].c >= t.max_players) return { error: "Tournament is full" };

    await query(
      "INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [tournamentId, userId]
    );
    return { joined: true };
  },

  // بداية البطولة — بيبني الدور الأول ويحل الـ byes تلقائيًا
  async start(tournamentId, requesterId) {
    const t = await this.getById(tournamentId);
    if (!t) return { error: "Tournament not found" };
    if (t.creator_id !== requesterId) return { error: "Only the creator can start the tournament" };
    if (t.status !== "open") return { error: "Tournament already started" };

    const players = await this.getPlayers(tournamentId);
    if (players.length < 2) return { error: "Need at least 2 players" };

    const shuffled = shuffle(players);
    const bracketSize = nextPow2(shuffled.length);
    while (shuffled.length < bracketSize) shuffled.push(null); // byes

    for (let i = 0; i < bracketSize / 2; i++) {
      const p1 = shuffled[i * 2], p2 = shuffled[i * 2 + 1];
      const isBye = !p1 || !p2;
      const winnerId = isBye ? (p1?.id || p2?.id || null) : null;
      await query(
        `INSERT INTO tournament_matches (tournament_id, round, position, player1_id, player2_id, winner_id, status)
         VALUES ($1, 1, $2, $3, $4, $5, $6)`,
        [tournamentId, i, p1?.id ?? null, p2?.id ?? null, winnerId, isBye ? "bye" : "pending"]
      );
    }

    await query("UPDATE tournaments SET status = 'in_progress', started_at = CURRENT_TIMESTAMP WHERE id = $1", [tournamentId]);

    // لو كل ماتشات الدور الأول byes (نادر، مثلاً بطولة بلاعبين اتنين مفيش bye أصلًا) نحاول نتقدم فورًا
    await this.maybeAdvanceRound(tournamentId, 1);
    return { started: true };
  },

  async reportResult(matchId, reporterId, winnerId) {
    const matchRes = await query("SELECT * FROM tournament_matches WHERE id = $1", [matchId]);
    const match = matchRes.rows[0];
    if (!match) return { error: "Match not found" };
    if (match.status !== "pending") return { error: "Match already resolved" };
    if (![match.player1_id, match.player2_id].includes(Number(winnerId))) return { error: "Winner must be one of the two players" };
    // لازم المُبلّغ يكون أحد اللاعبين الاتنين (تبسيط بدل نظام تحكيم كامل)
    if (![match.player1_id, match.player2_id].includes(reporterId)) return { error: "Only participants can report this match" };

    await query("UPDATE tournament_matches SET winner_id = $2, status = 'done' WHERE id = $1", [matchId, winnerId]);
    await this.maybeAdvanceRound(match.tournament_id, match.round);
    return { reported: true };
  },

  // لو كل ماتشات الدور خلصت، يبني الدور اللي بعده (أو يقفل البطولة لو ده كان النهائي)
  async maybeAdvanceRound(tournamentId, round) {
    const res = await query(
      "SELECT * FROM tournament_matches WHERE tournament_id = $1 AND round = $2 ORDER BY position",
      [tournamentId, round]
    );
    const matches = res.rows;
    if (matches.some(m => m.status === "pending")) return; // لسه مفيش نتيجة لكل الماتشات

    const winners = matches.map(m => m.winner_id);

    if (winners.length === 1) {
      await query(
        "UPDATE tournaments SET status = 'finished', winner_id = $2, finished_at = CURRENT_TIMESTAMP WHERE id = $1",
        [tournamentId, winners[0]]
      );
      return;
    }

    const nextRound = round + 1;
    for (let i = 0; i < winners.length / 2; i++) {
      const p1 = winners[i * 2], p2 = winners[i * 2 + 1];
      await query(
        `INSERT INTO tournament_matches (tournament_id, round, position, player1_id, player2_id, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT (tournament_id, round, position) DO NOTHING`,
        [tournamentId, nextRound, i, p1, p2]
      );
    }
  },
};

module.exports = Tournament;
