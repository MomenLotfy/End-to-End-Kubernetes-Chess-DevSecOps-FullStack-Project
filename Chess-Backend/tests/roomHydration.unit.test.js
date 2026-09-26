// Wave 7 Phase 4 — DB-truth room cache: lazy hydration, refresh-on-mutation,
// cross-replica presence, websocket-only transports. Real socket.io client +
// server over websocket; the Game model is an in-memory fake (same shape as
// the real queries). Cross-replica DIVERGENCE is simulated honestly: local
// socket attachments are nulled while adapter-visible sockets stay joined,
// which is exactly what a second replica observes.
"use strict";

process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const http = require("http");
const { Server } = require("socket.io");
const ioClient = require("socket.io-client");
const { signAccessToken, ACCESS_COOKIE } = require("../src/services/tokens");

jest.mock("../src/middleware/auth", () => ({
  activeSession: jest.fn(async () => true),
  authMiddleware: jest.fn((req, res, next) => next()),
  optionalAuth: jest.fn((req, res, next) => next()),
}));

const mockDb = { games: new Map(), moves: [], nextId: 1 };
function mockResult(rows = [], rowCount = rows.length) { return { rows, rowCount }; }

jest.mock("../src/models/Game", () => {
  const { Chess } = require("chess.js");
  const api = {
    __mockDb: mockDb,
    // The transaction client is ignored: runInTransaction is faked, so all
    // writes land directly in mockDb (same observable effect, no SQL).
    create: jest.fn(async ({ roomId, whiteUserId, whiteUsername }) => {
      const game = { id: mockDb.nextId++, room_id: roomId, white_user_id: whiteUserId, white_username: whiteUsername,
        black_user_id: null, black_username: null, status: "in_progress", board_fen: new Chess().fen(),
        started_at: new Date().toISOString(), result: null, winner_color: null };
      mockDb.games.set(game.id, game);
      return { ...game };
    }),
    claimBlack: jest.fn(async (id, player) => {
      const game = mockDb.games.get(id);
      if (!game || game.black_username || game.status !== "in_progress") return null;
      game.black_user_id = player.blackUserId; game.black_username = player.blackUsername;
      return { ...game };
    }),
    joinBlackById: jest.fn(async (id, player) => api.claimBlack(id, player)),
    // Mirrors the real snapshot: game row + ordered moves, any status.
    findRoomSnapshot: jest.fn(async roomId => {
      const game = [...mockDb.games.values()].find(g => g.room_id === roomId);
      if (!game) return null;
      const persisted_moves = mockDb.moves.filter(m => m.game_id === game.id)
        .sort((a, b) => a.move_number - b.move_number);
      return { ...game, persisted_moves };
    }),
    findRecoverable: jest.fn(async () => []),
    abandonMany: jest.fn(async ids => {
      for (const id of ids) {
        const game = mockDb.games.get(id);
        if (game) game.status = "abandoned";
      }
      return ids.length;
    }),
    runInTransaction: jest.fn(async callback => callback({ query: querySql })),
  };
  async function querySql(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT board_fen, status FROM games")) {
      const game = mockDb.games.get(params[0]); return game ? mockResult([{ board_fen: game.board_fen, status: game.status }]) : mockResult();
    }
    if (normalized.startsWith("UPDATE games SET board_fen")) {
      const game = mockDb.games.get(params[0]);
      if (!game || game.status !== "in_progress") return mockResult();
      game.board_fen = params[1]; return mockResult([{ id: game.id }]);
    }
    if (normalized.startsWith("INSERT INTO moves")) {
      const record = { id: mockDb.moves.length + 1, game_id: params[0], move_number: mockDb.moves.filter(m => m.game_id === params[0]).length + 1,
        player_color: params[1], from_square: params[2], to_square: params[3], fen_after: params[7], san: params[6], promotion: params[8] };
      mockDb.moves.push(record); return mockResult([record]);
    }
    if (normalized.startsWith("UPDATE games SET status='finished'")) {
      const game = mockDb.games.get(params[0]);
      if (!game || game.status !== "in_progress") return mockResult();
      game.status = "finished"; game.result = params[1]; game.winner_color = params[2];
      return mockResult([{ id: game.id }]);
    }
    if (normalized.startsWith("SELECT id, elo_rating FROM users")) return mockResult([{ id: 1, elo_rating: 1200 }, { id: 2, elo_rating: 1200 }]);
    if (normalized.startsWith("UPDATE users SET elo_rating")) return mockResult([], 1);
    if (normalized.startsWith("INSERT INTO scores")) return mockResult([], 1);
    if (normalized.startsWith("SELECT COUNT(*)::int AS count FROM scores")) return mockResult([{ count: 1 }]);
    if (normalized.startsWith("INSERT INTO user_achievements")) return mockResult([], 1);
    if (normalized.startsWith("UPDATE games SET room_id=NULL")) {
      const game = mockDb.games.get(params[0]); if (!game || game.status !== "finished") return mockResult(); game.room_id = null; return mockResult([], 1);
    }
    throw new Error(`Unhandled test SQL: ${normalized}`);
  }
  return api;
});

const Game = require("../src/models/Game");
const metrics = require("../src/metrics");
const { initSocket, activeRooms, getRoom, refreshRoomFromDb, presenceByUser, normalizeRoomId } =
  require("../src/socket/gameSocket");
const { setRematchBackendForTests } = require("../src/services/rematchVotes");

const metricVal = (name, labels) => {
  const m = metrics.renderMetrics().match(new RegExp(`^${name}${labels} ([0-9.eE+-]+)$`, "m"));
  return m ? Number(m[1]) : 0;
};

function user(id, username) { return { id, username, email: `${username}@example.test` }; }
function cookieFor(profile) { return `${ACCESS_COOKIE}=${signAccessToken(profile)}`; }
function event(socket, name) { return new Promise(resolve => socket.once(name, resolve)); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(ioFactory = server => new Server(server)) {
  const server = http.createServer();
  const io = ioFactory(server);
  initSocket(io);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const connect = profile => new Promise((resolve, reject) => {
    const socket = ioClient(url, { extraHeaders: { Cookie: cookieFor(profile) }, forceNew: true, transports: ["websocket"] });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
  const close = async sockets => {
    sockets.forEach(socket => socket.disconnect());
    // Belt-and-braces: server-side sweep so a mid-test assertion failure
    // (which skips the manual disconnects) still tears down fast instead
    // of hanging server.close on open websocket connections.
    for (const serverSocket of io.sockets.sockets.values()) serverSocket.disconnect(true);
    await new Promise(resolve => io.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  };
  return { connect, close, io, url };
}

async function joinedGame(connect) {
  const white = await connect(user(1, "Alice"));
  const black = await connect(user(2, "Bob"));
  const created = event(white, "room_created");
  white.emit("create_room", {});
  const { roomId } = await created;
  const startedWhite = event(white, "game_start");
  const startedBlack = event(black, "game_start");
  black.emit("join_room", { roomId });
  await Promise.all([startedWhite, startedBlack]);
  return { white, black, roomId };
}

beforeEach(() => {
  activeRooms.clear();
  mockDb.games.clear();
  mockDb.moves.length = 0;
  mockDb.nextId = 1;
  // Game ids restart at 1 every test, so the vote backend MUST be reset too
  // or game-1 votes would leak across tests (same key, stale quorum).
  setRematchBackendForTests(null);
  jest.clearAllMocks();
});

// --- room id format -----------------------------------------------------------------

test("normalizeRoomId accepts exactly the generator alphabet, uppercased", () => {
  expect(normalizeRoomId("abc123-")).toBe("ABC123-");
  expect(normalizeRoomId("XYZ_789")).toBe("XYZ_789");
  for (const bad of ["short", "TOOLONG12", "ABCDEF!", "ABC DEF", "", null, undefined, 123, "abcdefg!", "ABCDEFGH"]) {
    expect(normalizeRoomId(bad)).toBeNull();
  }
});

// --- hydration ----------------------------------------------------------------------

test("join hydrates a cache-missed room from DB truth", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    // Simulate a cold replica (or a restart): cache gone, DB intact.
    activeRooms.delete(roomId);
    const before = metricVal("room_hydrations_total", '{outcome="created"}');
    // White re-joins on the "cold" replica: hydrate + reattach + game_start.
    const started = event(white, "game_start");
    white.emit("join_room", { roomId });
    const payload = await started;
    expect(payload.roomId).toBe(roomId);
    expect(payload.players).toHaveLength(2);
    expect(metricVal("room_hydrations_total", '{outcome="created"}')).toBe(before + 1);
    // ... and play continues on the hydrated room.
    const moved = event(black, "move_made");
    white.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    await moved;
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("malformed room ids fail WITHOUT a DB hit", async () => {
  const h = await harness();
  try {
    const white = await h.connect(user(1, "Alice"));
    const callsBefore = Game.findRoomSnapshot.mock.calls.length;
    const invalidBefore = metricVal("room_hydrations_total", '{outcome="invalid"}');
    const err = event(white, "error");
    white.emit("join_room", { roomId: "not a room!!" });
    expect(await err).toEqual({ message: "Room not found" });
    expect(Game.findRoomSnapshot.mock.calls.length).toBe(callsBefore);
    expect(metricVal("room_hydrations_total", '{outcome="invalid"}')).toBe(invalidBefore + 1);
    white.disconnect();
  } finally { await h.close([]); }
});

test("wellformed-but-unknown room ids fail closed after one snapshot read", async () => {
  const h = await harness();
  try {
    const white = await h.connect(user(1, "Alice"));
    const before = metricVal("room_hydrations_total", '{outcome="not_found"}');
    const err = event(white, "error");
    white.emit("join_room", { roomId: "ZZZZZZZ" });
    expect(await err).toEqual({ message: "Room not found" });
    expect(metricVal("room_hydrations_total", '{outcome="not_found"}')).toBe(before + 1);
    white.disconnect();
  } finally { await h.close([]); }
});

test("corrupt games are abandoned at hydration, never materialized", async () => {
  const h = await harness();
  try {
    const white = await h.connect(user(1, "Alice"));
    const created = event(white, "room_created");
    white.emit("create_room", {});
    const { roomId } = await created;
    const game = [...mockDb.games.values()].find(g => g.room_id === roomId);
    game.board_fen = "not-a-fen";
    activeRooms.delete(roomId);
    const err = event(white, "error");
    white.emit("join_room", { roomId });
    expect(await err).toEqual({ message: "Room not found" });
    expect(Game.abandonMany).toHaveBeenCalledWith([game.id]);
    expect(game.status).toBe("abandoned");
    white.disconnect();
  } finally { await h.close([]); }
});

test("non-join paths never hydrate: misses fail WITHOUT a DB read or cache entry", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    activeRooms.delete(roomId); // cold cache; a move must NOT materialize it
    const callsBefore = Game.findRoomSnapshot.mock.calls.length;
    const err = event(white, "error");
    white.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    expect(await err).toEqual({ message: "Game not available" });
    expect(Game.findRoomSnapshot.mock.calls.length).toBe(callsBefore);
    expect(activeRooms.has(roomId)).toBe(false);
    // ... the room is still joinable afterwards (nothing poisoned).
    const started = event(white, "game_start");
    white.emit("join_room", { roomId });
    await started;
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("refresh DB faults keep the entry (retry, not rejoin)", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const errorBefore = metricVal("room_hydrations_total", '{outcome="error"}');
    Game.findRoomSnapshot.mockRejectedValueOnce(new Error("connection reset"));
    const err = event(white, "error");
    white.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    expect(await err).toEqual({ message: "Game not available" }); // fail closed
    expect(metricVal("room_hydrations_total", '{outcome="error"}')).toBe(errorBefore + 1);
    expect(activeRooms.has(roomId)).toBe(true); // NOT evicted on a fault
    // ... next event retries the refresh and plays on.
    const moved = event(black, "move_made");
    white.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    expect((await moved).moveCount).toBe(1);
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("rejected joins evict socketless rooms (no probe lingering)", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const ended = event(white, "game_ended");
    white.emit("resign", { roomId });
    await ended;
    white.disconnect(); black.disconnect();
    await delay(100);
    activeRooms.delete(roomId); // cold cache
    const stranger = await h.connect(user(3, "Mallory"));
    const err = event(stranger, "error");
    stranger.emit("join_room", { roomId }); // hydrated, then rejected (full)
    expect(await err).toEqual({ message: "Room is full" });
    await delay(50);
    expect(activeRooms.has(roomId)).toBe(false); // not left lingering
    stranger.disconnect();
  } finally { await h.close([]); }
});

test("leave vacates finished rooms (both members out → evicted)", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const ended = event(white, "game_ended");
    white.emit("resign", { roomId });
    await ended;
    const leftWhite = new Promise(resolve => white.emit("leave_room", { roomId }, resolve));
    expect(await leftWhite).toEqual({ left: true });
    expect(activeRooms.has(roomId)).toBe(true); // black still attached
    const leftBlack = new Promise(resolve => black.emit("leave_room", { roomId }, resolve));
    expect(await leftBlack).toEqual({ left: true });
    expect(activeRooms.has(roomId)).toBe(false); // finished + empty → evicted
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("leave during a DB fault still detaches and acks (finalize skipped)", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    Game.findRoomSnapshot.mockRejectedValueOnce(new Error("connection reset"));
    const acked = new Promise(resolve => white.emit("leave_room", { roomId }, resolve));
    expect(await acked).toEqual({ left: true });
    expect(activeRooms.get(roomId).players.find(p => p.userId === 1).id).toBeNull();
    expect(activeRooms.has(roomId)).toBe(true); // entry kept for recovery
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("concurrent cache misses share one hydration (no forked room objects)", async () => {
  const h = await harness();
  try {
    const white = await h.connect(user(1, "Alice"));
    const created = event(white, "room_created");
    white.emit("create_room", {});
    const { roomId } = await created;
    activeRooms.delete(roomId);
    Game.findRoomSnapshot.mockClear();
    const [a, b] = await Promise.all([getRoom(roomId), getRoom(roomId)]);
    expect(a).toBe(b);
    expect(Game.findRoomSnapshot).toHaveBeenCalledTimes(1);
    white.disconnect();
  } finally { await h.close([]); }
});

// --- refresh-on-mutation ---------------------------------------------------------------

test("moves heal a poisoned cache from DB truth", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const room = activeRooms.get(roomId);
    room.turn = "b"; // poison: claims black to move (actually white)
    room.moves.push({ from_square: "xx", to_square: "yy" }); // poison: phantom move
    const refreshedBefore = metricVal("room_hydrations_total", '{outcome="refreshed"}');
    const moved = event(black, "move_made");
    white.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    const payload = await moved; // stale cache would have rejected ("Not your turn")
    expect(payload.moveCount).toBe(1);
    expect(payload.moveHistory).toEqual([{ from: "e2", to: "e4", promotion: undefined, san: expect.anything() }]);
    expect(metricVal("room_hydrations_total", '{outcome="refreshed"}')).toBeGreaterThanOrEqual(refreshedBefore + 1);
    expect(activeRooms.get(roomId).turn).toBe("b");
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("a stale refresh preserves attachments made since (live-entry reattach)", async () => {
  const h = await harness();
  try {
    const white = await h.connect(user(1, "Alice"));
    const created = event(white, "room_created");
    white.emit("create_room", {});
    const { roomId } = await created;
    const stale = activeRooms.get(roomId); // white-only object reference
    const black = await h.connect(user(2, "Bob"));
    const started = event(white, "game_start");
    black.emit("join_room", { roomId });
    await started; // Bob attached on the LIVE (refreshed) object
    expect(activeRooms.get(roomId)).not.toBe(stale);
    // A task holding the pre-join reference refreshes now: it must adopt
    // the LIVE attachments, not clobber them with its stale player table.
    const live = await refreshRoomFromDb(stale);
    expect(live.players.find(p => p.userId === 2).id).toBe(black.id);
    expect(live.players.find(p => p.userId === 1).id).toBe(white.id);
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("a stale loser cache adopts the rematch won elsewhere", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const oldGameId = activeRooms.get(roomId).gameId;
    const ended = event(white, "game_ended");
    white.emit("resign", { roomId });
    await ended;
    // "Another replica" wins a rematch: old game released, new game same room.
    const oldGame = mockDb.games.get(oldGameId);
    oldGame.room_id = null;
    const fresh = await Game.create({ roomId, whiteUserId: 2, whiteUsername: "Bob" });
    await Game.claimBlack(fresh.id, { blackUserId: 1, blackUsername: "Alice" });
    // White (now black in the new game... wait, white is Alice=black) moves
    // on the STALE room: refresh must adopt the new game, where Bob (white)
    // is to move — so Alice's move is correctly "Not your turn", but the
    // cache heals to the new game id instead of erroring "not active".
    const err = event(white, "error");
    white.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    expect(await err).toEqual({ message: "Not your turn" });
    expect(activeRooms.get(roomId).gameId).toBe(fresh.id);
    // ... and the side to move plays on the adopted game.
    const moved = event(white, "move_made");
    black.emit("make_move", { roomId, move: { from: "e2", to: "e4" } });
    expect((await moved).moveCount).toBe(1);
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

// --- finished-game hydration + ended replay --------------------------------------------

test("rematch-rejoin on a cold replica replays the ending (no client change needed)", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const endedWhite = event(white, "game_ended");
    white.emit("resign", { roomId }); // white resigns → Bob wins
    await endedWhite;
    black.disconnect();
    await delay(50);
    activeRooms.delete(roomId); // cold replica: nobody here saw the game
    const black2 = await h.connect(user(2, "Bob"));
    const replayed = event(black2, "game_ended");
    black2.emit("join_room", { roomId });
    const payload = await replayed;
    expect(payload).toMatchObject({ result: "resign", winner: "Bob", replayed: true, eloChange: null });
    expect(payload.totalMoves).toBe(0);
    // ... and the rematch itself works from the hydrated finished room.
    const votes = require("../src/services/rematchVotes").rematchVotes();
    const gameId = activeRooms.get(roomId).gameId;
    await votes.addVote(gameId, 1); // Alice's vote, cast "elsewhere"
    const restarted = event(black2, "game_start");
    const restartedWhite = event(white, "game_start");
    black2.emit("accept_rematch", { roomId });
    await Promise.all([restarted, restartedWhite]);
    white.disconnect(); black2.disconnect();
  } finally { await h.close([]); }
});

// --- cross-replica presence --------------------------------------------------------------

test("rematch resolves when the opponent is adapter-present but locally detached", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const ended = event(white, "game_ended");
    white.emit("resign", { roomId });
    await ended;
    // DIVERGENCE (the cross-replica shape): this replica's player table
    // says Bob is gone, but his socket is still joined (adapter-visible).
    activeRooms.get(roomId).players.find(p => p.userId === 2).id = null;
    const votes = require("../src/services/rematchVotes").rematchVotes();
    const gameId = activeRooms.get(roomId).gameId;
    await votes.addVote(gameId, 2); // Bob's vote, cast "on the other replica"
    // Phase-3 local gate would stall here (Bob id null); presence resolves.
    const restartedWhite = event(white, "game_start");
    const restartedBlack = event(black, "game_start");
    white.emit("accept_rematch", { roomId });
    const [wPayload] = await Promise.all([restartedWhite, restartedBlack]);
    expect(wPayload.players).toHaveLength(2);
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

test("rematch waits while presence is incomplete, resolves on rejoin", async () => {
  const h = await harness();
  try {
    const { white, black, roomId } = await joinedGame(h.connect);
    const ended = event(white, "game_ended");
    white.emit("resign", { roomId });
    await ended;
    black.disconnect(); // really gone: adapter agrees he is absent
    await delay(100);
    white.emit("accept_rematch", { roomId });
    const noStart = await Promise.race([
      event(white, "game_start").then(() => "started"),
      delay(300).then(() => "waited"),
    ]);
    expect(noStart).toBe("waited"); // quorum alone (1 vote) never resolves
    const votes = require("../src/services/rematchVotes").rematchVotes();
    const gameId = activeRooms.get(roomId).gameId;
    await votes.addVote(gameId, 2); // Bob voted BEFORE disconnecting
    white.emit("accept_rematch", { roomId }); // re-accept: quorum 2, presence 1
    const stillNoStart = await Promise.race([
      event(white, "game_start").then(() => "started"),
      delay(300).then(() => "waited"),
    ]);
    expect(stillNoStart).toBe("waited"); // presence gate holds: no phantom game
    const black2 = await h.connect(user(2, "Bob"));
    const rejoined = event(black2, "game_ended"); // ended replay on rejoin
    black2.emit("join_room", { roomId });
    await rejoined;
    const restarted = event(black2, "game_start");
    black2.emit("accept_rematch", { roomId }); // Bob present again → resolve
    await restarted;
    white.disconnect(); black2.disconnect();
  } finally { await h.close([]); }
});

test("presenceByUser: shape, failures fail closed, malformed entries skipped", async () => {
  const good = { in: () => ({ fetchSockets: async () => ([
    { data: { user: { id: 1 } } }, { data: { user: { id: 2 } } }, { data: {} }, {}, null,
  ]) }) };
  expect(await presenceByUser(good, "AAAAAAA", [1, 2, 3])).toEqual(new Set([1, 2]));
  const failedBefore = metricVal("presence_checks_total", '{outcome="failed"}');
  const broken = { in: () => ({ fetchSockets: async () => { throw new Error("redis down"); } }) };
  expect(await presenceByUser(broken, "AAAAAAA", [1])).toEqual(new Set());
  expect(metricVal("presence_checks_total", '{outcome="failed"}')).toBe(failedBefore + 1);
});

test("a dead adapter blocks resolution loudly (metric, no game, votes kept)", async () => {
  const h = await harness(server => {
    const io = new Server(server);
    // Only fetchSockets is broken (Redis down): everything else is real.
    return Object.create(io, { in: { value: () => ({ fetchSockets: async () => { throw new Error("redis down"); } }) } });
  });
  try {
    // With presence broken, join's bothConnected is always false: black's
    // join lands on room_rejoined (which also proves the joiner-color fix —
    // a fresh non-completing join must not crash on reconnecting.color).
    const white = await h.connect(user(1, "Alice"));
    const black = await h.connect(user(2, "Bob"));
    const created = event(white, "room_created");
    white.emit("create_room", {});
    const { roomId } = await created;
    // Black joins: presence fails → not bothConnected → room_rejoined.
    const rejoined = event(black, "room_rejoined");
    black.emit("join_room", { roomId });
    const rejoinPayload = await rejoined;
    expect(rejoinPayload.color).toBe("b"); // joiner-color fix (no crash)
    // Finish via resign, then both vote: resolution must NOT happen.
    const ended = event(white, "game_ended");
    white.emit("resign", { roomId });
    await ended;
    const failedBefore = metricVal("presence_checks_total", '{outcome="failed"}');
    white.emit("accept_rematch", { roomId });
    black.emit("accept_rematch", { roomId });
    const noStart = await Promise.race([
      event(white, "game_start").then(() => "started"),
      delay(400).then(() => "waited"),
    ]);
    expect(noStart).toBe("waited");
    expect(metricVal("presence_checks_total", '{outcome="failed"}')).toBeGreaterThanOrEqual(failedBefore + 1);
    white.disconnect(); black.disconnect();
  } finally { await h.close([]); }
});

// --- websocket-only transports ----------------------------------------------------------------

test("our server rejects polling at the engine (400 Transport unknown)", async () => {
  const { createApplication } = require("../src/server");
  const application = createApplication();
  await new Promise(resolve => application.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = application.server.address().port;
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }).on("error", reject);
    });
    expect(status).toBe(400);
  } finally {
    await new Promise(resolve => application.io.close(resolve));
    if (application.server.listening) await new Promise(resolve => application.server.close(resolve));
  }
});

test("our server accepts websocket clients end to end", async () => {
  const { createApplication } = require("../src/server");
  const application = createApplication();
  await new Promise(resolve => application.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = application.server.address().port;
    const socket = await new Promise((resolve, reject) => {
      const s = ioClient(`http://127.0.0.1:${port}`, {
        extraHeaders: { Cookie: cookieFor(user(9, "Zed")) }, forceNew: true, transports: ["websocket"],
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
    socket.disconnect();
  } finally {
    await new Promise(resolve => application.io.close(resolve));
    if (application.server.listening) await new Promise(resolve => application.server.close(resolve));
  }
});
