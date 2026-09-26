process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const http = require("http");
const { Server } = require("socket.io");
const ioClient = require("socket.io-client");
const { signAccessToken, ACCESS_COOKIE } = require("../src/services/tokens");

jest.mock("../src/middleware/auth", () => ({ activeSession: jest.fn(async () => true) }));

const mockDb = { games: new Map(), moves: [], nextId: 1, finalizeCount: 0 };
function mockResult(rows = [], rowCount = rows.length) { return { rows, rowCount }; }

jest.mock("../src/models/Game", () => {
  const { Chess } = require("chess.js");
  const api = {
    create: jest.fn(async ({ roomId, whiteUserId, whiteUsername }) => {
      const game = { id: mockDb.nextId++, room_id: roomId, white_user_id: whiteUserId, white_username: whiteUsername,
        black_user_id: null, black_username: null, status: "in_progress", board_fen: new Chess().fen(),
        started_at: new Date().toISOString(), result: null, winner_color: null };
      mockDb.games.set(game.id, game);
      return { ...game };
    }),
    // Wave 7 Phase 4: snapshot = game row + ordered moves (any status —
    // acceptance is the caller's job, mirroring the real query).
    findRoomSnapshot: jest.fn(async roomId => {
      const game = [...mockDb.games.values()].find(g => g.room_id === roomId);
      if (!game) return null;
      const persisted_moves = mockDb.moves.filter(m => m.game_id === game.id)
        .sort((a, b) => a.move_number - b.move_number);
      return { ...game, persisted_moves };
    }),
    claimBlack: jest.fn(async (id, player) => {
      const game = mockDb.games.get(id);
      if (!game || game.black_username || game.status !== "in_progress") return null;
      game.black_user_id = player.blackUserId; game.black_username = player.blackUsername;
      return { ...game };
    }),
    joinBlackById: jest.fn(async (id, player) => api.claimBlack(id, player)),
    findRecoverable: jest.fn(async () => []),
    abandonMany: jest.fn(async () => 0),
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
        player_color: params[1], from_square: params[2], to_square: params[3], fen_after: params[7] };
      mockDb.moves.push(record); return mockResult([record]);
    }
    if (normalized.startsWith("UPDATE games SET status='finished'")) {
      const game = mockDb.games.get(params[0]);
      if (!game || game.status !== "in_progress") return mockResult();
      game.status = "finished"; game.result = params[1]; game.winner_color = params[2]; mockDb.finalizeCount++;
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

const { initSocket, activeRooms, rebuildActiveRooms } = require("../src/socket/gameSocket");

function user(id, username) { return { id, username, email: `${username}@example.test` }; }
function cookieFor(profile) { return `${ACCESS_COOKIE}=${signAccessToken(profile)}`; }
function event(socket, name) { return new Promise(resolve => socket.once(name, resolve)); }

async function harness() {
  const server = http.createServer();
  const io = new Server(server);
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
    await new Promise(resolve => io.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  };
  return { connect, close, io };
}

async function joinedGame(connect) {
  const white = await connect(user(1, "Alice"));
  const black = await connect(user(2, "Bob"));
  const created = event(white, "room_created");
  white.emit("create_room", { playerName: "forged-name" });
  const { roomId } = await created;
  const startedWhite = event(white, "game_start");
  const startedBlack = event(black, "game_start");
  black.emit("join_room", { roomId, playerName: "also-forged" });
  await Promise.all([startedWhite, startedBlack]);
  return { white, black, roomId };
}

beforeEach(() => {
  mockDb.games.clear(); mockDb.moves.length = 0; mockDb.nextId = 1; mockDb.finalizeCount = 0; activeRooms.clear(); jest.clearAllMocks();
});

test("startup rebuilds an in-progress room from persisted FEN and moves", async () => {
  const Game = require("../src/models/Game");
  const fen = new (require("chess.js").Chess)().fen();
  Game.findRecoverable.mockResolvedValueOnce([{
    id: 44, room_id: "RECOVER1", white_user_id: 1, white_username: "Alice",
    black_user_id: 2, black_username: "Bob", board_fen: fen,
    started_at: new Date(), persisted_moves: [{ move_number: 1 }],
  }]);
  expect(await rebuildActiveRooms()).toBe(1);
  expect(activeRooms.get("RECOVER1")).toMatchObject({ gameId: 44, board: fen, turn: "w", status: "playing" });
  expect(activeRooms.get("RECOVER1").moves).toHaveLength(1);
});

test("make_move authorizes participant and turn and persists canonical data", async () => {
  const h = await harness();
  const sockets = [];
  try {
    const game = await joinedGame(h.connect); sockets.push(game.white, game.black);
    const attacker = await h.connect(user(3, "Mallory")); sockets.push(attacker);
    const denied = event(attacker, "error");
    attacker.emit("make_move", { roomId: game.roomId, move: { from: "e2", to: "e4" } });
    expect((await denied).message).toBe("Not your turn");
    const moved = event(game.black, "move_made");
    game.white.emit("make_move", { roomId: game.roomId, move: { from: "e2", to: "e4", piece: "wQ", boardState: "forged" } });
    const payload = await moved;
    expect(payload.turn).toBe("b");
    expect(payload.boardState).not.toBe("forged");
    expect(mockDb.moves[0]).toMatchObject({ game_id: 1, player_color: "w", from_square: "e2", to_square: "e4" });
  } finally { await h.close(sockets); }
});

test("parallel join_room attempts admit only one black player", async () => {
  const h = await harness();
  const sockets = [];
  try {
    const white = await h.connect(user(1, "Alice")); const b = await h.connect(user(2, "Bob")); const c = await h.connect(user(3, "Carol"));
    sockets.push(white, b, c);
    const created = event(white, "room_created"); white.emit("create_room", {}); const { roomId } = await created;
    const bOutcome = Promise.race([event(b, "game_start").then(() => "joined"), event(b, "error").then(() => "rejected")]);
    const cOutcome = Promise.race([event(c, "game_start").then(() => "joined"), event(c, "error").then(() => "rejected")]);
    b.emit("join_room", { roomId }); c.emit("join_room", { roomId });
    expect((await Promise.all([bOutcome, cOutcome])).sort()).toEqual(["joined", "rejected"]);
    expect(activeRooms.get(roomId).players).toHaveLength(2);
  } finally { await h.close(sockets); }
});

test("network disconnect preserves the authoritative game for reconnect", async () => {
  const h = await harness();
  const sockets = [];
  try {
    const game = await joinedGame(h.connect); sockets.push(game.white, game.black);
    const serverSockets = [...h.io.sockets.sockets.values()];
    serverSockets.forEach(socket => socket.disconnect(true));
    await Promise.all(serverSockets.map(socket => {
      const playerRoom = activeRooms.get(game.roomId);
      return playerRoom?.operation;
    }));
    await activeRooms.get(game.roomId)?.operation;
    expect(mockDb.finalizeCount).toBe(0);
    expect(mockDb.games.get(1).status).toBe("in_progress");
    expect(activeRooms.get(game.roomId).players.every(player => player.id === null)).toBe(true);
  } finally { await h.close(sockets); }
});

test("rematch requires both votes and creates exactly one new persisted game", async () => {
  const h = await harness();
  const sockets = [];
  try {
    const game = await joinedGame(h.connect); sockets.push(game.white, game.black);
    const ended = event(game.black, "game_ended"); game.white.emit("resign", { roomId: game.roomId }); await ended;
    game.white.emit("accept_rematch", { roomId: game.roomId });
    await activeRooms.get(game.roomId).operation;
    expect(mockDb.games.size).toBe(1);
    const whiteStart = event(game.white, "game_start"); const blackStart = event(game.black, "game_start");
    game.black.emit("accept_rematch", { roomId: game.roomId });
    const [first, second] = await Promise.all([whiteStart, blackStart]);
    expect(first.players.find(p => p.userId === 1).color).toBe("b");
    expect(second.roomId).toBe(game.roomId);
    expect(mockDb.games.size).toBe(2);
    expect(activeRooms.get(game.roomId).status).toBe("playing");
  } finally { await h.close(sockets); }
});
