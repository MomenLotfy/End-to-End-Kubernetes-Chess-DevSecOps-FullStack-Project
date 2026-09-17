process.env.JWT_SECRET ||= "integration-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const crypto = require("crypto");
const { pool } = require("../src/config/db");
const Game = require("../src/models/Game");
const Tournament = require("../src/models/Tournament");
const AuthToken = require("../src/models/AuthToken");
const { persistMoveAtomic, finalizeGameAtomic } = require("../src/socket/gameSocket");

jest.setTimeout(30000);
const suffix = () => crypto.randomBytes(6).toString("hex");

async function createUser(name = `u${suffix()}`) {
  const result = await pool.query(
    `INSERT INTO users (username,email,password_hash,email_verified_at)
     VALUES ($1,$2,'integration-hash',CURRENT_TIMESTAMP) RETURNING *`,
    [name.slice(0, 20), `${name}@example.test`]
  );
  return result.rows[0];
}

async function createMultiplayerGame() {
  const white = await createUser();
  const black = await createUser();
  const game = await Game.create({ roomId: `R${suffix()}`.slice(0, 12), whiteUserId: white.id, whiteUsername: white.username });
  await Game.claimBlack(game.id, { blackUserId: black.id, blackUsername: black.username });
  return { game, white, black };
}

beforeAll(async () => {
  const database = await pool.query("SELECT current_database() AS name");
  if (!/_test$/.test(database.rows[0].name)) throw new Error("Integration tests require a database name ending in _test");
});

afterAll(async () => {
  await pool.query("TRUNCATE refresh_tokens, account_tokens, user_achievements, tournament_matches, tournament_players, tournaments, scores, moves, games, friendships, users RESTART IDENTITY CASCADE");
  await pool.end();
});

test("all migrations and required database objects exist", async () => {
  const migrations = await pool.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
  expect(migrations.rows.map(row => row.filename)).toEqual([
    "001_init.sql", "002_game_features.sql", "003_achievements.sql", "004_friends.sql",
    "005_tournaments.sql", "006_security_integrity.sql", "007_fullstack_hardening.sql",
  ]);
  expect(migrations.rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
  const expectedConstraints = [
    "games_game_mode_check", "games_result_check", "games_status_check", "games_winner_color_check",
    "moves_game_id_move_number_key", "moves_from_square_check", "moves_number_positive_check",
    "moves_player_color_check", "moves_promotion_check", "moves_to_square_check",
    "scores_duration_nonnegative_check", "scores_moves_positive_check", "tournaments_max_players_check",
    "users_session_version_check",
  ];
  const constraints = await pool.query(
    "SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[]) ORDER BY conname", [expectedConstraints]
  );
  expect(constraints.rows.map(row => row.conname)).toEqual([...expectedConstraints].sort());
  const expectedIndexes = [
    "idx_account_tokens_lookup", "idx_games_active_room", "idx_moves_game_id",
    "idx_refresh_tokens_family", "idx_refresh_tokens_hash", "idx_refresh_tokens_user_active",
    "idx_scores_one_per_game_user", "idx_tourn_matches_tid", "idx_tourn_players_tid", "idx_users_elo",
  ];
  const indexes = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname", [expectedIndexes]
  );
  expect(indexes.rows.map(row => row.indexname)).toEqual([...expectedIndexes].sort());
  const trigger = await pool.query("SELECT 1 FROM pg_trigger WHERE tgname='tournament_capacity_guard' AND NOT tgisinternal");
  expect(trigger.rowCount).toBe(1);
});

test("concurrent moves serialize on the game row and only one white move commits", async () => {
  const { game, white } = await createMultiplayerGame();
  const room = { gameId: game.id };
  const player = { userId: white.id, color: "w" };
  const outcomes = await Promise.all([
    persistMoveAtomic(room, player, { from: "e2", to: "e4" }),
    persistMoveAtomic(room, player, { from: "d2", to: "d4" }),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const moves = await pool.query("SELECT * FROM moves WHERE game_id=$1", [game.id]);
  expect(moves.rowCount).toBe(1);
});

test("duplicate move number is rejected by PostgreSQL", async () => {
  const { game } = await createMultiplayerGame();
  const insert = () => pool.query(
    `INSERT INTO moves (game_id,move_number,player_color,from_square,to_square,piece)
     VALUES ($1,1,'w','e2','e4','wP')`, [game.id]
  );
  const results = await Promise.allSettled([insert(), insert()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")[0].reason.code).toBe("23505");
});

test("parallel game finalization settles status, scores and ELO exactly once", async () => {
  const { game, white, black } = await createMultiplayerGame();
  const room = {
    gameId: game.id,
    players: [
      { userId: white.id, name: white.username, color: "w" },
      { userId: black.id, name: black.username, color: "b" },
    ],
    moves: [{}, {}, {}, {}],
    createdAt: Date.now() - 1000,
  };
  const results = await Promise.all([
    finalizeGameAtomic(room, "checkmate", "w"),
    finalizeGameAtomic(room, "checkmate", "w"),
  ]);
  expect(results.filter(result => result.settled)).toHaveLength(1);
  const state = await pool.query("SELECT status,result,winner_color FROM games WHERE id=$1", [game.id]);
  expect(state.rows[0]).toEqual({ status: "finished", result: "checkmate", winner_color: "w" });
  const users = await pool.query("SELECT id,elo_rating FROM users WHERE id=ANY($1::int[]) ORDER BY id", [[white.id, black.id]]);
  expect(users.rows.map(row => row.elo_rating).sort((a, b) => a - b)).toEqual([1184, 1216]);
  expect((await pool.query("SELECT 1 FROM scores WHERE game_id=$1", [game.id])).rowCount).toBe(2);
  const awards = await pool.query(
    "SELECT achievement_key FROM user_achievements WHERE user_id=$1 ORDER BY achievement_key", [white.id]
  );
  expect(awards.rows.map(row => row.achievement_key)).toEqual(["first_game", "first_win", "quick_win"]);
});

test("parallel tournament joins never exceed capacity", async () => {
  const owner = await createUser();
  const tournament = await Tournament.create(owner.id, `Tournament ${suffix()}`, 4);
  const entrants = await Promise.all(Array.from({ length: 12 }, () => createUser()));
  const outcomes = await Promise.all(entrants.map(user => Tournament.join(tournament.id, user.id)));
  expect(outcomes.filter(result => result.joined)).toHaveLength(3);
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM tournament_players WHERE tournament_id=$1", [tournament.id]);
  expect(count.rows[0].count).toBe(4);
});

test("parallel tournament start and match reports create and advance the bracket once", async () => {
  const owner = await createUser();
  const opponent = await createUser();
  const tournament = await Tournament.create(owner.id, `Race ${suffix()}`, 4);
  expect((await Tournament.join(tournament.id, opponent.id)).joined).toBe(true);
  const starts = await Promise.all([Tournament.start(tournament.id, owner.id), Tournament.start(tournament.id, owner.id)]);
  expect(starts.filter(result => result.started)).toHaveLength(1);
  const matches = await pool.query("SELECT * FROM tournament_matches WHERE tournament_id=$1", [tournament.id]);
  expect(matches.rowCount).toBe(1);
  const reports = await Promise.all([
    Tournament.reportResult(matches.rows[0].id, owner.id, owner.id),
    Tournament.reportResult(matches.rows[0].id, opponent.id, owner.id),
  ]);
  expect(reports.filter(result => result.reported)).toHaveLength(1);
  const state = await pool.query("SELECT status,winner_id FROM tournaments WHERE id=$1", [tournament.id]);
  expect(state.rows[0]).toEqual({ status: "finished", winner_id: owner.id });
});

test("parallel refresh rotation detects reuse and revokes the token family", async () => {
  const user = await createUser();
  const original = await AuthToken.issueRefreshToken(user.id);
  const outcomes = await Promise.all([AuthToken.rotateRefreshToken(original), AuthToken.rotateRefreshToken(original)]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const family = await pool.query(
    "SELECT consumed_at,revoked_at FROM refresh_tokens WHERE user_id=$1 ORDER BY id", [user.id]
  );
  expect(family.rowCount).toBe(2);
  expect(family.rows.every(row => row.revoked_at)).toBe(true);
});
