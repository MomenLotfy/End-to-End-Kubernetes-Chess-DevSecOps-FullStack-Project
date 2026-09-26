const cookie = require("cookie");
const { Chess } = require("chess.js");
const logger = require("../config/logger");
const Game = require("../models/Game");
const { computeNewRatings } = require("../utils/elo");
const { ACCESS_COOKIE, verifyAccessToken } = require("../services/tokens");
const { activeSession } = require("../middleware/auth");
const socketMetrics = require("../metrics/socket");
const shutdownMetrics = require("../metrics/shutdown");
const { rematchVotes, RematchUnavailable } = require("../services/rematchVotes");
const { withTimeout } = require("../services/redis");
const {
  ROOM_MS: SHUTDOWN_ROOM_BUDGET_MS, ShutdownDrainError, isShutdownDrainError,
  isDraining, drainHandshakeGuard, drainPacketGuard,
} = require("../services/shutdown");

// Wave 7 Phase 4: activeRooms is a DISPOSABLE DB-TRUTH CACHE, not shared
// state. Any replica materializes any room from PostgreSQL on demand
// (hydrate on miss, refresh before every mutation decision), so entries
// are never synchronized — they are rebuilt from the same truth and
// converge by construction. Socket ids stay process-local attachments;
// cross-replica presence comes from the adapter (fetchSockets), and row
// locks remain the cross-process arbiter for all writes.
const activeRooms = new Map();

// In-flight hydrations, keyed by room id: concurrent cache misses for one
// room share a single DB read AND a single room object (two objects would
// fork the per-room operation chain — see getRoom).
const hydrating = new Map();

// Room ids are EXACTLY what generateRoomId produces: 5 random bytes as
// base64url (7 chars, no padding), uppercased. Anything else is rejected
// WITHOUT a DB hit (malformed ids can never hydrate). Keep this in sync
// with the generator — a narrower pattern orphans real rooms.
const ROOM_ID_FORMAT = /^[A-Z0-9\-_]{7}$/;

// Presence queries (adapter round-trip, Redis-backed in redis mode) are
// bounded: a slow/dead adapter fails the check CLOSED, never hangs a room.
const PRESENCE_TIMEOUT_MS = 3000;

// Rematch quorum: both players must vote (votes are distinct validated
// userIds in the shared rematch:{gameId} set, so 2 == unanimous).
const REMATCH_QUORUM = 2;

async function socketAuthentication(socket, next) {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || "");
    if (!cookies[ACCESS_COOKIE]) { socketMetrics.onAuthFailure(); return next(new Error("Authentication required")); }
    const payload = verifyAccessToken(cookies[ACCESS_COOKIE]);
    if (!await activeSession(payload)) { socketMetrics.onAuthFailure(); return next(new Error("Authentication required")); }
    socket.data.user = payload;
    next();
  } catch (err) {
    logger.warn(`Socket authentication rejected: ${err.name}`);
    socketMetrics.onAuthFailure();
    next(new Error("Authentication required"));
  }
}

// Wave 7 Phase 6: DRAINING admission gate (the backstop behind the socket
// packet gate). While draining, new work is REJECTED with a controlled
// error the caller already handles — never silently dropped, and never
// linked onto the chain (the chain object is untouched, so the room-phase
// snapshot stays valid and no failure metric fires for a routine drain).
function roomTask(room, task) {
  if (isDraining()) {
    shutdownMetrics.onRejectedWork("room");
    logger.debug(`Room ${room.id} operation rejected (draining)`);
    return Promise.reject(new ShutdownDrainError());
  }
  const run = room.operation.then(task, task);
  room.operation = run.catch(err => {
    logger.error(`Room ${room.id} operation failed`, { error: err.stack });
    socketMetrics.onRoomOperationFailure();
  });
  return run;
}

function publicPlayers(room) {
  return room.players.map(({ id, name, color, userId }) => ({ id, name, color, userId }));
}

// Shared room builder: ONE code path materializes a room from a DB snapshot
// for boot warm-up, lazy hydration, and refresh. Returns null for corrupt
// games (logged + abandoned, exactly the old boot behavior). Socket ids are
// always null here — callers reattach their own process-local sockets.
// No rematchVotes field: votes live in the rematchVotes service, never here.
async function buildRoomFromSnapshot(game) {
  let chess;
  try {
    const persistedMoves = game.persisted_moves || [];
    const checkpoint = game.board_fen || persistedMoves.at(-1)?.fen_after;
    if (checkpoint) {
      chess = new Chess(checkpoint);
    } else {
      chess = new Chess();
      for (const move of persistedMoves) {
        const replayed = chess.move({ from: move.from_square, to: move.to_square, promotion: move.promotion || undefined });
        if (!replayed) throw new Error(`Illegal persisted move ${move.move_number}`);
      }
    }
  } catch (err) {
    logger.error(`Cannot recover game ${game.id}: invalid FEN`, { error: err.message });
    await Game.abandonMany([game.id]);
    return null;
  }
  const players = [{ id: null, name: game.white_username, color: "w", userId: game.white_user_id }];
  if (game.black_username) players.push({ id: null, name: game.black_username, color: "b", userId: game.black_user_id });
  return {
    id: game.room_id,
    gameId: game.id,
    players,
    chess,
    board: chess.fen(),
    turn: chess.turn(),
    // A finished snapshot stays finished (rematch-rejoin materializes ended
    // games on any replica); live games derive waiting/playing from seats.
    status: game.status === "finished" ? "finished" : players.length === 2 ? "playing" : "waiting",
    moves: game.persisted_moves || [],
    createdAt: new Date(game.started_at || Date.now()).getTime(),
    recovered: true,
    operation: Promise.resolve(),
    // Final-game facts for the ended-replay on rematch-rejoin (null while
    // the game is live; read from DB truth, never synthesized).
    gameResult: game.result || null,
    gameWinnerColor: game.winner_color || null,
  };
}

async function rebuildActiveRooms() {
  activeRooms.clear();
  const games = await Game.findRecoverable();
  for (const game of games) {
    const room = await buildRoomFromSnapshot(game);
    if (room) activeRooms.set(room.id, room);
  }
  logger.info(`Recovered ${activeRooms.size} active game room(s)`);
  return activeRooms.size;
}

function normalizeRoomId(roomId) {
  const normalized = String(roomId || "").toUpperCase();
  return ROOM_ID_FORMAT.test(normalized) ? normalized : null;
}

// Only live-or-ended multiplayer games materialize. Anything else
// (abandoned, another mode, released by a rematch) is cache-dead.
function isMaterializable(snapshot) {
  return !!snapshot && (snapshot.status === "in_progress" || snapshot.status === "finished");
}

// Materialize one room from DB truth (cache-miss path). Convergent: every
// replica builds the same game fields from the same row; socket ids attach
// afterwards and stay local.
async function hydrateRoom(normalizedRoomId) {
  let snapshot = null;
  try {
    snapshot = await Game.findRoomSnapshot(normalizedRoomId);
  } catch (err) {
    logger.error(`Room hydration query failed for room ${normalizedRoomId}`, { error: err.message });
    socketMetrics.onHydration("error");
    return null;
  }
  if (!isMaterializable(snapshot)) {
    socketMetrics.onHydration("not_found");
    return null;
  }
  const room = await buildRoomFromSnapshot(snapshot);
  if (!room) {
    socketMetrics.onHydration("error");
    return null;
  }
  activeRooms.set(room.id, room);
  socketMetrics.onHydration("created");
  return room;
}

async function getRoom(roomId) {
  const normalized = normalizeRoomId(roomId);
  if (!normalized) {
    socketMetrics.onHydration("invalid");
    return null;
  }
  const cached = activeRooms.get(normalized);
  if (cached) return cached;
  let inflight = hydrating.get(normalized);
  if (!inflight) {
    inflight = hydrateRoom(normalized).finally(() => { hydrating.delete(normalized); });
    hydrating.set(normalized, inflight);
  }
  return inflight;
}

// Cache-only lookup for every path EXCEPT join: move/resign/rematch/leave
// all require a LOCAL socket attachment, and attachments exist only on
// cached rooms — so a miss here is authoritative WITHOUT a DB read. This
// keeps stray calls from materializing (and lingering) rooms nobody uses,
// and keeps not_found/invalid strictly join-path (hydration) signals.
function getCachedRoom(roomId) {
  const normalized = normalizeRoomId(roomId);
  if (!normalized) return null;
  return activeRooms.get(normalized) || null;
}

// Evict a cached room when NO local socket uses it (rejected joins must
// not linger hydrated rooms behind). Takes a CACHE KEY (room.id, normalized
// by construction), never a raw client-supplied id. Safe under concurrency:
// the check runs on the live entry, and a racing attach either wins (no
// evict) or re-hydrates afterwards (one extra snapshot read, same truth).
function evictIfSocketless(cacheKey) {
  const live = activeRooms.get(cacheKey);
  if (live && live.players.every(player => !player.id)) activeRooms.delete(cacheKey);
}

// Re-sync a cached room with DB truth BEFORE the caller decides anything.
// Returns the live room object (callers MUST use the return value — refresh
// may replace the object), or null when truth is unavailable: the caller
// fails closed WITHOUT deciding off the stale entry. Only PROVEN-dead
// entries are evicted (no materializable snapshot); a DB FAULT keeps the
// entry (untouched, still stale-marked by failure) so the next event
// retries instead of forcing a rejoin. Socket attachments survive by
// userId — rematch swaps colors, so reattachment matches on user, never
// color/index. The per-room operation chain is carried onto the new
// object, so refresh inside a roomTask never forks serialization.
async function refreshRoomFromDb(room) {
  let snapshot = null;
  try {
    snapshot = await Game.findRoomSnapshot(room.id);
  } catch (err) {
    logger.error(`Room refresh failed for room ${room.id}`, { error: err.message });
    socketMetrics.onHydration("error");
    return null;
  }
  if (!isMaterializable(snapshot)) {
    activeRooms.delete(room.id);
    socketMetrics.onHydration("not_found");
    return null;
  }
  const rebuilt = await buildRoomFromSnapshot(snapshot);
  if (!rebuilt) {
    activeRooms.delete(room.id);
    socketMetrics.onHydration("error");
    return null;
  }
  // Reattach from the LIVE entry, not the (possibly stale) argument: a task
  // that fetched its room reference before a concurrent refresh replaced
  // the object must not clobber attachments made since (same for the op
  // chain — the live entry always holds the current tail).
  const current = activeRooms.get(room.id) || room;
  const localSockets = new Map((current.players || []).map(player => [player.userId, player.id]));
  for (const player of rebuilt.players) player.id = localSockets.get(player.userId) || null;
  rebuilt.operation = current.operation;
  activeRooms.set(room.id, rebuilt);
  socketMetrics.onHydration("refreshed");
  return rebuilt;
}

// Cross-replica presence: which of these userIds have ≥1 socket in the
// room ANYWHERE in the cluster (adapter fetchSockets — local-only in local
// mode, which is exact at 1 replica). Failures and timeouts return the
// EMPTY set (fail closed: the caller waits instead of starting/resolving
// a game with phantom players). Never throws.
async function presenceByUser(io, roomId, userIds) {
  try {
    const sockets = await withTimeout(
      io.in(roomId).fetchSockets(), PRESENCE_TIMEOUT_MS, "Presence fetch"
    );
    const seen = new Set();
    for (const socket of sockets || []) {
      const id = socket?.data?.user?.id;
      if (Number.isInteger(id)) seen.add(id);
    }
    socketMetrics.onPresenceCheck("ok");
    return new Set((userIds || []).filter(id => seen.has(id)));
  } catch (err) {
    logger.warn(`Presence check failed for room ${roomId} (treating users as absent)`, { error: err.message });
    socketMetrics.onPresenceCheck("failed");
    return new Set();
  }
}

async function finalizeGameAtomic(room, result, winnerColor) {
  return Game.runInTransaction(async client => {
    const finished = await client.query(
      `UPDATE games SET status='finished', result=$2, winner_color=$3, ended_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND status='in_progress' RETURNING id`,
      [room.gameId, result, winnerColor]
    );
    if (finished.rowCount === 0) return { settled: false, eloChange: null };
    if (finished.rowCount !== 1) throw new Error("Game finalization affected multiple rows");

    const white = room.players.find(player => player.color === "w");
    const black = room.players.find(player => player.color === "b");
    if (!white?.userId || !black?.userId) return { settled: true, eloChange: null };

    const ids = [white.userId, black.userId].sort((a, b) => a - b);
    const users = await client.query("SELECT id, elo_rating FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
    if (users.rowCount !== 2) throw new Error("ELO participants missing");
    const whiteUser = users.rows.find(user => user.id === white.userId);
    const blackUser = users.rows.find(user => user.id === black.userId);
    const whiteScore = winnerColor === "w" ? 1 : winnerColor === "b" ? 0 : 0.5;
    const [whiteElo, blackElo] = computeNewRatings(whiteUser.elo_rating, blackUser.elo_rating, whiteScore);
    const whiteUpdate = await client.query("UPDATE users SET elo_rating=$2 WHERE id=$1", [white.userId, whiteElo]);
    const blackUpdate = await client.query("UPDATE users SET elo_rating=$2 WHERE id=$1", [black.userId, blackElo]);
    if (whiteUpdate.rowCount !== 1 || blackUpdate.rowCount !== 1) throw new Error("ELO update failed");

    const duration = Math.max(0, Math.floor((Date.now() - room.createdAt) / 1000));
    for (const player of [white, black]) {
      const score = await client.query(
        `INSERT INTO scores (user_id,username,moves,duration_seconds,winner,game_mode,game_id)
         VALUES ($1,$2,$3,$4,$5,'multiplayer',$6)
         ON CONFLICT (game_id,user_id) WHERE game_id IS NOT NULL AND user_id IS NOT NULL DO NOTHING`,
        [player.userId, player.name, room.moves.length, duration, player.color === winnerColor, room.gameId]
      );
      if (score.rowCount !== 1) throw new Error("Authoritative score insertion conflict");
      const keys = ["first_game"];
      if (player.color === winnerColor) {
        const wins = await client.query("SELECT COUNT(*)::int AS count FROM scores WHERE user_id=$1 AND winner=true", [player.userId]);
        if (wins.rows[0].count >= 1) keys.push("first_win");
        if (wins.rows[0].count >= 5) keys.push("wins_5");
        if (wins.rows[0].count >= 10) keys.push("wins_10");
        if (wins.rows[0].count >= 25) keys.push("wins_25");
        if (room.moves.length <= 15) keys.push("quick_win");
      }
      if (room.moves.length >= 60) keys.push("marathon");
      await client.query(
        `INSERT INTO user_achievements (user_id,achievement_key)
         SELECT $1, unnest($2::varchar[]) ON CONFLICT (user_id,achievement_key) DO NOTHING`,
        [player.userId, keys]
      );
    }
    return {
      settled: true,
      eloChange: {
        white: { username: white.name, old: whiteUser.elo_rating, new: whiteElo },
        black: { username: black.name, old: blackUser.elo_rating, new: blackElo },
      },
    };
  });
}

async function persistMoveAtomic(room, player, requestedMove) {
  return Game.runInTransaction(async client => {
    const locked = await client.query("SELECT board_fen, status FROM games WHERE id=$1 FOR UPDATE", [room.gameId]);
    if (locked.rowCount !== 1 || locked.rows[0].status !== "in_progress") throw new Error("Game is no longer active");
    const chess = new Chess(locked.rows[0].board_fen || undefined);
    if (chess.turn() !== player.color) return null;
    let canonical;
    try {
      canonical = chess.move({ from: requestedMove?.from, to: requestedMove?.to, promotion: requestedMove?.promotion });
    } catch (_) { canonical = null; }
    if (!canonical) return null;
    const fen = chess.fen();
    const updated = await client.query(
      "UPDATE games SET board_fen=$2 WHERE id=$1 AND status='in_progress' RETURNING id", [room.gameId, fen]
    );
    if (updated.rowCount !== 1) throw new Error("Board update conflict");
    const inserted = await client.query(
      `INSERT INTO moves (game_id,move_number,player_color,from_square,to_square,piece,captured_piece,san,fen_after,promotion)
       SELECT $1, COALESCE(MAX(move_number),0)+1, $2,$3,$4,$5,$6,$7,$8,$9 FROM moves WHERE game_id=$1 RETURNING *`,
      [room.gameId, player.color, canonical.from, canonical.to, `${player.color}${canonical.piece.toUpperCase()}`,
        canonical.captured ? `${player.color === "w" ? "b" : "w"}${canonical.captured.toUpperCase()}` : null,
        canonical.san, fen, canonical.promotion || null]
    );
    if (inserted.rowCount !== 1) throw new Error("Move insert failed");
    return { chess, move: canonical, record: inserted.rows[0] };
  });
}

function endedPayload(room, result, winner, eloChange) {
  return {
    result,
    winner,
    totalMoves: room.moves.length,
    duration: Math.max(0, Math.floor((Date.now() - room.createdAt) / 1000)),
    eloChange,
  };
}

function initSocket(io) {
  socketMetrics.attach(io, activeRooms);
  // Wave 7 Phase 6: drain guards run FIRST (before auth/session checks) so
  // a draining process refuses new work without spending auth/session cost.
  io.use(drainHandshakeGuard);
  io.use(socketAuthentication);
  io.on("connection", socket => {
    logger.info(`Socket connected: ${socket.id}`);
    socketMetrics.onConnect();
    socket.use((packet, next) => drainPacketGuard(socket, packet, next));
    socket.use(async (_packet, next) => {
      try {
        if (await activeSession(socket.data.user)) return next();
      } catch (error) { logger.warn("Socket session check failed", { error: error.message }); }
      next(new Error("Authentication required"));
    });

    socket.on("create_room", async ({ playerName } = {}) => {
      try {
        const name = socket.data.user.username || String(playerName || "").slice(0, 20);
        // Locally-unique id; a cross-replica collision fails LOUDLY on the
        // DB UNIQUE(room_id) below ("Unable to create room", client retries).
        const roomId = generateRoomId();
        const game = await Game.create({ roomId, whiteUserId: socket.data.user.id, whiteUsername: name });
        const chess = new Chess(game.board_fen);
        const room = {
          id: roomId, gameId: game.id, chess, board: chess.fen(), turn: "w", status: "waiting",
          players: [{ id: socket.id, name, color: "w", userId: socket.data.user.id }],
          moves: [], createdAt: Date.now(), recovered: false, operation: Promise.resolve(),
          gameResult: null, gameWinnerColor: null,
        };
        activeRooms.set(roomId, room);
        socket.join(roomId);
        socket.emit("room_created", { roomId, color: "w" });
      } catch (err) {
        logger.error("Create room failed", { error: err.stack });
        socket.emit("error", { message: "Unable to create room" });
      }
    });

    socket.on("join_room", async ({ roomId } = {}) => {
      // Miss = hydrate from DB truth (this replica simply never saw the
      // room — including finished games for rematch-rejoin on any replica).
      const room = await getRoom(roomId);
      if (!room) return socket.emit("error", { message: "Room not found" });
      try {
        await roomTask(room, async () => {
          const live = await refreshRoomFromDb(room);
          if (!live) return socket.emit("error", { message: "Room not found" });
          const reconnecting = live.players.find(player => player.userId === socket.data.user.id && !player.id);
          if (reconnecting) {
            reconnecting.id = socket.id;
          } else {
            if (live.players.some(player => player.userId === socket.data.user.id)) throw new Error("Already joined");
            if (live.players.length >= 2 || live.status !== "waiting") throw new Error("Room is full");
            // DB-atomic seat claim (SELECT FOR UPDATE + conditional UPDATE):
            // simultaneous joins on N replicas serialize — one wins.
            const game = await Game.claimBlack(live.gameId, {
              blackUserId: socket.data.user.id,
              blackUsername: socket.data.user.username,
            });
            if (!game) throw new Error("Room is full");
            live.players.push({ id: socket.id, name: socket.data.user.username, color: "b", userId: socket.data.user.id });
            live.status = "playing";
          }
          socket.join(live.id);
          // Rejoining an ENDED game replays its ending (result/winner from
          // DB truth; ELO deltas were emitted once at finalization and are
          // intentionally not refabricated). game_start is for live games.
          if (live.status === "finished") {
            const winner = live.players.find(player => player.color === live.gameWinnerColor)?.name || null;
            return socket.emit("game_ended", {
              result: live.gameResult, winner, totalMoves: live.moves.length,
              duration: Math.max(0, Math.floor((Date.now() - live.createdAt) / 1000)),
              eloChange: null, replayed: true,
            });
          }
          // Presence is cluster-wide (adapter fetchSockets), not local
          // socket ids: the opponent may be connected on another replica.
          const present = await presenceByUser(io, live.id, live.players.map(player => player.userId));
          const bothConnected = live.players.length === 2 && live.players.every(player => present.has(player.userId));
          const historyOf = target => target.moves.map(record => ({ from: record.from_square, to: record.to_square, promotion: record.promotion || undefined, san: record.san }));
          if (bothConnected) {
            io.to(live.id).emit("game_start", {
              roomId: live.id, players: publicPlayers(live), turn: live.turn, boardState: live.board, recovered: live.recovered,
              moveHistory: historyOf(live),
            });
          } else {
            // The joiner's own seat (fresh joins are always black;
            // reconnects reuse their seat) — never reconnecting.color, which
            // crashes when a fresh join doesn't complete the pair.
            const joiner = live.players.find(player => player.id === socket.id);
            socket.emit("room_rejoined", { roomId: live.id, color: joiner?.color || "b", boardState: live.board, turn: live.turn });
          }
        });
      } catch (err) {
        // Rejected joins must not linger hydrated rooms: evict only when no
        // local socket uses the entry (evictIfSocketless is race-safe).
        evictIfSocketless(room.id);
        socket.emit("error", { message: err.message === "Already joined" ? "Already joined" : "Room is full" });
      }
    });

    socket.on("make_move", async ({ roomId, move } = {}) => {
      // Cache-only: the mover must be attached HERE (see getCachedRoom).
      const room = getCachedRoom(roomId);
      if (!room) return socket.emit("error", { message: "Game not available" });
      roomTask(room, async () => {
        // Decide off DB truth, not a possibly-stale cache: a stale turn or
        // status here would wrongly reject a legal move (or silently drop
        // it). Refresh also heals the move history every replica emits.
        const live = await refreshRoomFromDb(room);
        if (!live) return socket.emit("error", { message: "Game not available" });
        if (live.status !== "playing") return;
        const player = live.players.find(candidate => candidate.id === socket.id);
        if (!player || player.color !== live.turn) return socket.emit("error", { message: "Not your turn" });

        let persisted;
        try {
          persisted = await persistMoveAtomic(live, player, move);
        } catch (err) {
          logger.error(`Move persistence failed for game ${live.gameId}`, { error: err.stack });
          return socket.emit("error", { message: "Unable to record move" });
        }
        if (!persisted) return socket.emit("error", { message: "Illegal move" });
        live.chess = persisted.chess;
        live.board = persisted.chess.fen();
        live.turn = persisted.chess.turn();
        live.moves.push(persisted.record);
        io.to(live.id).emit("move_made", {
          move: persisted.move,
          boardState: live.board,
          turn: live.turn,
          moveCount: live.moves.length,
          moveHistory: live.moves.map(record => ({
            from: record.from_square, to: record.to_square, promotion: record.promotion || undefined, san: record.san,
          })),
        });
        if (live.chess.isGameOver()) {
          const result = live.chess.isCheckmate() ? "checkmate" : "draw";
          const winnerColor = result === "checkmate" ? (live.turn === "w" ? "b" : "w") : null;
          const winner = live.players.find(candidate => candidate.color === winnerColor)?.name || null;
          try {
            const finalized = await finalizeGameAtomic(live, result, winnerColor);
            if (finalized.settled) {
              live.status = "finished";
              live.gameResult = result;
              live.gameWinnerColor = winnerColor;
              io.to(live.id).emit("game_ended", endedPayload(live, result, winner, finalized.eloChange));
            }
          } catch (err) {
            logger.error("Automatic game finalization failed", { error: err.stack });
            socket.emit("error", { message: "Move recorded; unable to finalize game" });
          }
        }
      }).catch(() => socket.emit("error", { message: "Unable to process move" }));
    });

    socket.on("game_over", async ({ roomId } = {}) => {
      const room = getCachedRoom(roomId);
      if (!room) return;
      roomTask(room, async () => {
        const live = await refreshRoomFromDb(room);
        if (!live) return;
        if (!live.players.some(player => player.id === socket.id)) return socket.emit("error", { message: "Not authorized" });
        if (!live.chess.isGameOver()) return socket.emit("error", { message: "Game not over" });
        if (live.status === "finished") return;
        const result = live.chess.isCheckmate() ? "checkmate" : "draw";
        const winnerColor = result === "checkmate" ? (live.turn === "w" ? "b" : "w") : null;
        const winner = live.players.find(candidate => candidate.color === winnerColor)?.name || null;
        const finalized = await finalizeGameAtomic(live, result, winnerColor);
        if (finalized.settled) {
          live.status = "finished";
          live.gameResult = result;
          live.gameWinnerColor = winnerColor;
          io.to(live.id).emit("game_ended", endedPayload(live, result, winner, finalized.eloChange));
        }
      }).catch(err => {
        logger.error("Game-over finalization failed", { error: err.stack });
        socket.emit("error", { message: "Unable to finalize game" });
      });
    });

    socket.on("resign", async ({ roomId } = {}) => {
      const room = getCachedRoom(roomId);
      if (!room) return;
      roomTask(room, async () => {
        const live = await refreshRoomFromDb(room);
        if (!live) return;
        if (live.status !== "playing") return;
        const caller = live.players.find(player => player.id === socket.id);
        if (!caller) return socket.emit("error", { message: "Not authorized" });
        const opponent = live.players.find(player => player.color !== caller.color);
        const finalized = await finalizeGameAtomic(live, "resign", opponent?.color || null);
        if (!finalized.settled) return;
        live.status = "finished";
        live.gameResult = "resign";
        live.gameWinnerColor = opponent?.color || null;
        io.to(live.id).emit("game_ended", endedPayload(live, "resign", opponent?.name || null, finalized.eloChange));
      }).catch(() => socket.emit("error", { message: "Unable to resign" }));
    });

    // Best-effort UX ping only (lights the opponent's rematch button). No
    // hydration: the accept path below is the real, DB-truth gate.
    socket.on("request_rematch", ({ roomId } = {}) => {
      const room = getCachedRoom(roomId);
      if (room?.players.some(player => player.id === socket.id) && room.status === "finished") {
        socket.to(room.id).emit("rematch_requested");
      }
    });

    socket.on("accept_rematch", async ({ roomId } = {}) => {
      // Cache-only: the voter must be attached HERE (see getCachedRoom).
      const room = getCachedRoom(roomId);
      if (!room) return;
      roomTask(room, async () => {
        const live = await refreshRoomFromDb(room);
        if (!live || live.status !== "finished") {
          return socket.emit("error", { message: "Not authorized" });
        }
        const voter = live.players.find(player => player.id === socket.id);
        if (!voter) return socket.emit("error", { message: "Not authorized" });
        // Votes are shared (Redis SET, TTL-bounded) in redis mode,
        // process-local (Map) in local mode — selected at STARTUP, never
        // a runtime fallback. Redis down in redis mode = controlled error.
        let votes;
        try {
          votes = await rematchVotes().addVote(live.gameId, voter.userId);
        } catch (err) {
          if (err instanceof RematchUnavailable) {
            return socket.emit("error", { message: "Rematch temporarily unavailable" });
          }
          throw err;
        }
        // Quorum = 2 distinct player votes AND both players present
        // ANYWHERE in the cluster (adapter presence, fail-closed). Two
        // replicas can reach quorum simultaneously — the DB release below
        // (atomic room_id=NULL … status='finished') serializes creation:
        // exactly one wins; the loser errors while its client still
        // receives the winner's cluster-wide game_start, and its stale
        // cache heals on the next refresh. Replicas stay 1 until Phase 7.
        const present = await presenceByUser(io, live.id, live.players.map(player => player.userId));
        if (votes.count < REMATCH_QUORUM || !live.players.every(player => present.has(player.userId))) return;
        const switched = live.players.map(player => ({ ...player, color: player.color === "w" ? "b" : "w" }));
        const white = switched.find(player => player.color === "w");
        const black = switched.find(player => player.color === "b");
        const game = await Game.runInTransaction(async client => {
          const released = await client.query("UPDATE games SET room_id=NULL WHERE id=$1 AND status='finished'", [live.gameId]);
          if (released.rowCount !== 1) throw new Error("Rematch room release failed");
          const created = await Game.create({ roomId: live.id, whiteUserId: white.userId, whiteUsername: white.name }, client);
          await Game.joinBlackById(created.id, { blackUserId: black.userId, blackUsername: black.name }, client);
          return created;
        });
        const previousGameId = live.gameId;
        live.gameId = game.id;
        live.players = switched;
        live.chess = new Chess(game.board_fen);
        live.board = live.chess.fen();
        live.turn = "w";
        live.moves = [];
        live.createdAt = Date.now();
        live.status = "playing";
        live.gameResult = null;
        live.gameWinnerColor = null;
        // Best-effort (never throws): stale votes also evaporate via TTL.
        await rematchVotes().clearVotes(previousGameId);
        io.to(live.id).emit("game_start", { roomId: live.id, players: publicPlayers(live), turn: "w", boardState: live.board });
      }).catch(err => { logger.error("Rematch failed", { error: err.stack }); socket.emit("error", { message: "Unable to start rematch" }); });
    });

    // No hydration: chat requires a LOCAL socket attachment, so a hydrated
    // room (all ids null) could never authorize the sender anyway.
    socket.on("send_message", ({ roomId, text } = {}) => {
      const room = getCachedRoom(roomId);
      const player = room?.players.find(candidate => candidate.id === socket.id);
      const clean = String(text || "").slice(0, 200).trim();
      // Emit to room.id (normalized), never the raw client string: io room
      // names are case-sensitive and a lowercase id would miss every socket.
      if (player && clean) io.to(room.id).emit("chat_message", { playerName: player.name, color: player.color, text: clean, time: Date.now() });
    });

    socket.on("leave_room", async ({ roomId } = {}, acknowledge = () => {}) => {
      const room = getCachedRoom(roomId);
      if (!room) return acknowledge({ left: true });
      roomTask(room, async () => {
        // Refresh before the finalize decision: a stale "finished" would
        // orphan a live game (skipped resign), a stale "playing" over a
        // finished game is harmless (finalize is idempotent) but refresh
        // makes it exact.
        const live = await refreshRoomFromDb(room);
        const target = live || room;
        const player = target.players.find(candidate => candidate.id === socket.id);
        // No truth (DB fault): still honor the client's declared leave
        // (detach + io-leave + ack) but skip the finalize decision, which
        // requires truth. The game keeps its DB state for recovery.
        if (!live) {
          if (!player) return acknowledge({ error: "Not authorized" });
          player.id = null;
          socket.leave(room.id);
          return acknowledge({ left: true });
        }
        if (!player) return acknowledge({ error: "Not authorized" });
        if (live.status === "playing") {
          const opponent = live.players.find(candidate => candidate.color !== player.color);
          const finalized = await finalizeGameAtomic(live, "resign", opponent?.color || null);
          if (finalized.settled) {
            live.status = "finished";
            live.gameResult = "resign";
            live.gameWinnerColor = opponent?.color || null;
            io.to(live.id).emit("game_ended", endedPayload(live, "resign", opponent?.name || null, finalized.eloChange));
          }
        }
        player.id = null;
        // Best-effort departure cleanup (never throws; TTL is the backstop).
        await rematchVotes().removeVote(live.gameId, player.userId);
        socket.leave(live.id);
        if (live.status === "finished" && live.players.every(candidate => !candidate.id)) {
          activeRooms.delete(live.id);
        }
        acknowledge({ left: true });
      }).catch(error => {
        logger.error("Leave room failed", { error: error.stack });
        acknowledge({ error: "Unable to leave room" });
      });
    });

    socket.on("disconnect", reason => {
      socketMetrics.onDisconnect(reason);
      for (const room of activeRooms.values()) {
        const player = room.players.find(candidate => candidate.id === socket.id);
        if (!player) continue;
        roomTask(room, async () => {
          // Re-lookup on the LIVE entry: refresh may have replaced the
          // object (and its players array) since iteration started —
          // detaching on a stale reference would orphan the socket id.
          const live = activeRooms.get(room.id) || room;
          const current = live.players.find(candidate => candidate.id === socket.id);
          if (!current) return;
          current.id = null;
          // Best-effort departure cleanup (never throws; TTL is the backstop).
          await rematchVotes().removeVote(live.gameId, current.userId);
          if (live.status === "playing") socket.to(live.id).emit("opponent_disconnected");
          if (live.status === "finished" && live.players.every(candidate => !candidate.id)) activeRooms.delete(live.id);
        }).catch(error => {
          // Wave 7 Phase 6: a drain rejection here is routine (the detach
          // is memory-only and the process is exiting; vote cleanup is
          // TTL-backed), not a failure worth an ERROR line per socket.
          if (isShutdownDrainError(error)) return;
          logger.error("Disconnect state update failed", { error: error.stack });
        });
        break;
      }
    });
  });
}

function generateRoomId() {
  let id;
  do { id = require("crypto").randomBytes(5).toString("base64url").slice(0, 8).toUpperCase(); } while (activeRooms.has(id));
  return id;
}

function touchedGameIds() {
  return [...activeRooms.values()].filter(room => room.status !== "finished").map(room => room.gameId).filter(Boolean);
}

// Wave 7 Phase 6: BOUNDED room drain. The snapshot is complete by
// construction: roomTask's gate-check and chain-link run synchronously, so
// once DRAINING, nothing can enqueue after this snapshot is taken. Expiry
// ABANDONS (never cancels): orphaned ops keep their own guarantees
// (statement timeouts, transactional chess writes, pool cap, process exit).
async function drainRoomOperations(budgetMs = SHUTDOWN_ROOM_BUDGET_MS) {
  const tails = [...activeRooms.values()].map(room => room.operation);
  if (tails.length === 0) return { total: 0, drained: 0, timedOut: false };
  const cap = Math.max(0, Number(budgetMs) || 0);
  if (!(cap > 0)) return { total: tails.length, drained: 0, timedOut: true };
  let drained = 0;
  const counted = tails.map(tail => Promise.resolve(tail).then(
    () => { drained += 1; },
    () => { drained += 1; }
  ));
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), cap);
  });
  const finished = await Promise.race([
    Promise.all(counted).then(() => true, () => true),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return { total: tails.length, drained, timedOut: !finished };
}

module.exports = {
  initSocket, activeRooms, rebuildActiveRooms, finalizeGameAtomic, persistMoveAtomic,
  touchedGameIds, drainRoomOperations, socketAuthentication,
  normalizeRoomId, getRoom, getCachedRoom, refreshRoomFromDb, presenceByUser, PRESENCE_TIMEOUT_MS,
  roomTask,
};
