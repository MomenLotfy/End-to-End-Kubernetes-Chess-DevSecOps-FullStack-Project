const { query, pool } = require("../config/db");

const nextPow2 = n => { let p = 1; while (p < n) p *= 2; return p; };
const shuffle = values => {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally { client.release(); }
}

async function advanceRound(client, tournamentId, round) {
  const tournament = await client.query("SELECT * FROM tournaments WHERE id=$1 FOR UPDATE", [tournamentId]);
  if (tournament.rowCount !== 1 || tournament.rows[0].status !== "in_progress") return;
  const result = await client.query(
    "SELECT * FROM tournament_matches WHERE tournament_id=$1 AND round=$2 ORDER BY position FOR UPDATE",
    [tournamentId, round]
  );
  if (!result.rowCount || result.rows.some(match => match.status === "pending")) return;
  const winners = result.rows.map(match => match.winner_id);
  if (winners.length === 1) {
    const finished = await client.query(
      `UPDATE tournaments SET status='finished',winner_id=$2,finished_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND status='in_progress'`, [tournamentId, winners[0]]
    );
    if (finished.rowCount !== 1) throw new Error("Tournament finalization conflict");
    return;
  }
  for (let position = 0; position < winners.length / 2; position++) {
    await client.query(
      `INSERT INTO tournament_matches (tournament_id,round,position,player1_id,player2_id,status)
       VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (tournament_id,round,position) DO NOTHING`,
      [tournamentId, round + 1, position, winners[position * 2], winners[position * 2 + 1]]
    );
  }
}

const Tournament = {
  async create(creatorId, name, maxPlayers) {
    return transaction(async client => {
      const created = await client.query(
        "INSERT INTO tournaments (name,creator_id,max_players,status) VALUES ($1,$2,$3,'open') RETURNING *",
        [name, creatorId, maxPlayers]
      );
      if (created.rowCount !== 1) throw new Error("Tournament creation failed");
      const joined = await client.query(
        "INSERT INTO tournament_players (tournament_id,user_id) VALUES ($1,$2) RETURNING id",
        [created.rows[0].id, creatorId]
      );
      if (joined.rowCount !== 1) throw new Error("Tournament creator join failed");
      return created.rows[0];
    });
  },
  async listOpen() {
    const result = await query(
      `SELECT t.*,COUNT(tp.id)::int AS player_count FROM tournaments t
       LEFT JOIN tournament_players tp ON tp.tournament_id=t.id
       WHERE t.status IN ('open','in_progress') GROUP BY t.id ORDER BY t.created_at DESC LIMIT 30`
    );
    return result.rows;
  },
  async getById(id) { const result = await query("SELECT * FROM tournaments WHERE id=$1", [id]); return result.rows[0] || null; },
  async getPlayers(id) {
    const result = await query(
      `SELECT u.id,u.username,u.avatar_url,u.elo_rating FROM tournament_players tp
       JOIN users u ON u.id=tp.user_id WHERE tp.tournament_id=$1 ORDER BY tp.joined_at`, [id]
    );
    return result.rows;
  },
  async getMatches(id) {
    const result = await query(
      `SELECT m.*,u1.username AS player1_name,u2.username AS player2_name,uw.username AS winner_name
       FROM tournament_matches m LEFT JOIN users u1 ON u1.id=m.player1_id
       LEFT JOIN users u2 ON u2.id=m.player2_id LEFT JOIN users uw ON uw.id=m.winner_id
       WHERE m.tournament_id=$1 ORDER BY m.round,m.position`, [id]
    );
    return result.rows;
  },

  async join(tournamentId, userId) {
    return transaction(async client => {
      const locked = await client.query("SELECT * FROM tournaments WHERE id=$1 FOR UPDATE", [tournamentId]);
      if (locked.rowCount !== 1) return { error: "Tournament not found" };
      if (locked.rows[0].status !== "open") return { error: "Tournament already started" };
      const existing = await client.query(
        "SELECT id FROM tournament_players WHERE tournament_id=$1 AND user_id=$2", [tournamentId, userId]
      );
      if (existing.rowCount) return { joined: true, alreadyJoined: true };
      const count = await client.query("SELECT COUNT(*)::int AS count FROM tournament_players WHERE tournament_id=$1", [tournamentId]);
      if (count.rows[0].count >= locked.rows[0].max_players) return { error: "Tournament is full" };
      const inserted = await client.query(
        "INSERT INTO tournament_players (tournament_id,user_id) VALUES ($1,$2) RETURNING id", [tournamentId, userId]
      );
      if (inserted.rowCount !== 1) throw new Error("Tournament join failed");
      return { joined: true };
    });
  },

  async start(tournamentId, requesterId) {
    return transaction(async client => {
      const locked = await client.query("SELECT * FROM tournaments WHERE id=$1 FOR UPDATE", [tournamentId]);
      if (locked.rowCount !== 1) return { error: "Tournament not found" };
      const tournament = locked.rows[0];
      if (tournament.creator_id !== requesterId) return { error: "Only the creator can start the tournament" };
      if (tournament.status !== "open") return { error: "Tournament already started" };
      const playersResult = await client.query(
        `SELECT u.id FROM tournament_players tp JOIN users u ON u.id=tp.user_id
         WHERE tp.tournament_id=$1 ORDER BY tp.joined_at FOR UPDATE OF tp`, [tournamentId]
      );
      if (playersResult.rowCount < 2) return { error: "Need at least 2 players" };
      const players = shuffle(playersResult.rows);
      while (players.length < nextPow2(players.length)) players.push(null);
      for (let position = 0; position < players.length / 2; position++) {
        const p1 = players[position * 2], p2 = players[position * 2 + 1];
        const winner = !p1 || !p2 ? (p1?.id || p2?.id) : null;
        const inserted = await client.query(
          `INSERT INTO tournament_matches (tournament_id,round,position,player1_id,player2_id,winner_id,status)
           VALUES ($1,1,$2,$3,$4,$5,$6) RETURNING id`,
          [tournamentId, position, p1?.id ?? null, p2?.id ?? null, winner, winner ? "bye" : "pending"]
        );
        if (inserted.rowCount !== 1) throw new Error("Bracket creation failed");
      }
      const updated = await client.query(
        "UPDATE tournaments SET status='in_progress',started_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='open'", [tournamentId]
      );
      if (updated.rowCount !== 1) throw new Error("Tournament start conflict");
      await advanceRound(client, tournamentId, 1);
      return { started: true };
    });
  },

  async reportResult(matchId, reporterId, winnerId) {
    return transaction(async client => {
      const matchResult = await client.query("SELECT * FROM tournament_matches WHERE id=$1 FOR UPDATE", [matchId]);
      if (matchResult.rowCount !== 1) return { error: "Match not found" };
      const match = matchResult.rows[0];
      if (match.status !== "pending") return { error: "Match already resolved" };
      const players = [match.player1_id, match.player2_id];
      if (!players.includes(Number(winnerId))) return { error: "Winner must be one of the two players" };
      if (!players.includes(reporterId)) return { error: "Only participants can report this match" };
      const updated = await client.query(
        "UPDATE tournament_matches SET winner_id=$2,status='done' WHERE id=$1 AND status='pending'", [matchId, winnerId]
      );
      if (updated.rowCount !== 1) throw new Error("Match result conflict");
      await advanceRound(client, match.tournament_id, match.round);
      return { reported: true };
    });
  },
  async maybeAdvanceRound(tournamentId, round) { return transaction(client => advanceRound(client, tournamentId, round)); },
};
module.exports = Tournament;
