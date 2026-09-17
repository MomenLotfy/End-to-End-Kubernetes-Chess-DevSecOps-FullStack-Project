const cookie = require("cookie");
const { Chess } = require("chess.js");
const logger = require("../config/logger");
const Game = require("../models/Game");
const { computeNewRatings } = require("../utils/elo");
const { ACCESS_COOKIE, verifyAccessToken } = require("../services/tokens");
const { activeSession } = require("../middleware/auth");

const activeRooms = new Map();

async function socketAuthentication(socket, next) {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || "");
    if (!cookies[ACCESS_COOKIE]) return next(new Error("Authentication required"));
    const payload = verifyAccessToken(cookies[ACCESS_COOKIE]);
    if (!await activeSession(payload)) return next(new Error("Authentication required"));
    socket.data.user = payload;
    next();
  } catch (err) {
    logger.warn(`Socket authentication rejected: ${err.name}`);
    next(new Error("Authentication required"));
  }
}

function roomTask(room, task) {
  const run = room.operation.then(task, task);
  room.operation = run.catch(err => logger.error(`Room ${room.id} operation failed`, { error: err.stack }));
  return run;
}

function publicPlayers(room) {
  return room.players.map(({ id, name, color, userId }) => ({ id, name, color, userId }));
}

async function rebuildActiveRooms() {
  activeRooms.clear();
  const games = await Game.findRecoverable();
  for (const game of games) {
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
      continue;
    }
    const players = [{ id: null, name: game.white_username, color: "w", userId: game.white_user_id }];
    if (game.black_username) players.push({ id: null, name: game.black_username, color: "b", userId: game.black_user_id });
    activeRooms.set(game.room_id, {
      id: game.room_id,
      gameId: game.id,
      players,
      chess,
      board: chess.fen(),
      turn: chess.turn(),
      status: players.length === 2 ? "playing" : "waiting",
      moves: game.persisted_moves || [],
      createdAt: new Date(game.started_at).getTime(),
      recovered: true,
      operation: Promise.resolve(),
      rematchVotes: new Set(),
    });
  }
  logger.info(`Recovered ${activeRooms.size} active game room(s)`);
  return activeRooms.size;
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
  io.use(socketAuthentication);
  io.on("connection", socket => {
    logger.info(`Socket connected: ${socket.id}`);
    socket.use(async (_packet, next) => {
      try {
        if (await activeSession(socket.data.user)) return next();
      } catch (error) { logger.warn("Socket session check failed", { error: error.message }); }
      next(new Error("Authentication required"));
    });

    socket.on("create_room", async ({ playerName } = {}) => {
      try {
        const name = socket.data.user.username || String(playerName || "").slice(0, 20);
        const roomId = generateRoomId();
        const game = await Game.create({ roomId, whiteUserId: socket.data.user.id, whiteUsername: name });
        const chess = new Chess(game.board_fen);
        const room = {
          id: roomId, gameId: game.id, chess, board: chess.fen(), turn: "w", status: "waiting",
          players: [{ id: socket.id, name, color: "w", userId: socket.data.user.id }],
          moves: [], createdAt: Date.now(), recovered: false, operation: Promise.resolve(), rematchVotes: new Set(),
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
      const room = activeRooms.get(String(roomId || "").toUpperCase());
      if (!room) return socket.emit("error", { message: "Room not found" });
      try {
        await roomTask(room, async () => {
          const reconnecting = room.players.find(player => player.userId === socket.data.user.id && !player.id);
          if (reconnecting) {
            reconnecting.id = socket.id;
          } else {
            if (room.players.some(player => player.userId === socket.data.user.id)) throw new Error("Already joined");
            if (room.players.length >= 2 || room.status !== "waiting") throw new Error("Room is full");
            const game = await Game.claimBlack(room.gameId, {
              blackUserId: socket.data.user.id,
              blackUsername: socket.data.user.username,
            });
            if (!game) throw new Error("Room is full");
            room.players.push({ id: socket.id, name: socket.data.user.username, color: "b", userId: socket.data.user.id });
            room.status = "playing";
          }
          socket.join(room.id);
          const bothConnected = room.players.length === 2 && room.players.every(player => player.id);
          if (bothConnected) {
            io.to(room.id).emit("game_start", {
              roomId: room.id, players: publicPlayers(room), turn: room.turn, boardState: room.board, recovered: room.recovered,
              moveHistory: room.moves.map(record => ({ from: record.from_square, to: record.to_square, promotion: record.promotion || undefined, san: record.san })),
            });
          } else {
            socket.emit("room_rejoined", { roomId: room.id, color: reconnecting.color, boardState: room.board, turn: room.turn });
          }
        });
      } catch (err) {
        socket.emit("error", { message: err.message === "Already joined" ? "Already joined" : "Room is full" });
      }
    });

    socket.on("make_move", ({ roomId, move } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return socket.emit("error", { message: "Game not available" });
      roomTask(room, async () => {
        if (room.status !== "playing") return;
        const player = room.players.find(candidate => candidate.id === socket.id);
        if (!player || player.color !== room.turn) return socket.emit("error", { message: "Not your turn" });

        let persisted;
        try {
          persisted = await persistMoveAtomic(room, player, move);
        } catch (err) {
          logger.error(`Move persistence failed for game ${room.gameId}`, { error: err.stack });
          return socket.emit("error", { message: "Unable to record move" });
        }
        if (!persisted) return socket.emit("error", { message: "Illegal move" });
        room.chess = persisted.chess;
        room.board = persisted.chess.fen();
        room.turn = persisted.chess.turn();
        room.moves.push(persisted.record);
        io.to(room.id).emit("move_made", {
          move: persisted.move,
          boardState: room.board,
          turn: room.turn,
          moveCount: room.moves.length,
          moveHistory: room.moves.map(record => ({
            from: record.from_square, to: record.to_square, promotion: record.promotion || undefined, san: record.san,
          })),
        });
        if (room.chess.isGameOver()) {
          const result = room.chess.isCheckmate() ? "checkmate" : "draw";
          const winnerColor = result === "checkmate" ? (room.turn === "w" ? "b" : "w") : null;
          const winner = room.players.find(candidate => candidate.color === winnerColor)?.name || null;
          try {
            const finalized = await finalizeGameAtomic(room, result, winnerColor);
            if (finalized.settled) {
              room.status = "finished";
              io.to(room.id).emit("game_ended", endedPayload(room, result, winner, finalized.eloChange));
            }
          } catch (err) {
            logger.error("Automatic game finalization failed", { error: err.stack });
            socket.emit("error", { message: "Move recorded; unable to finalize game" });
          }
        }
      }).catch(() => socket.emit("error", { message: "Unable to process move" }));
    });

    socket.on("game_over", ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return;
      roomTask(room, async () => {
        if (!room.players.some(player => player.id === socket.id)) return socket.emit("error", { message: "Not authorized" });
        if (!room.chess.isGameOver()) return socket.emit("error", { message: "Game not over" });
        if (room.status === "finished") return;
        const result = room.chess.isCheckmate() ? "checkmate" : "draw";
        const winnerColor = result === "checkmate" ? (room.turn === "w" ? "b" : "w") : null;
        const winner = room.players.find(candidate => candidate.color === winnerColor)?.name || null;
        const finalized = await finalizeGameAtomic(room, result, winnerColor);
        if (finalized.settled) {
          room.status = "finished";
          io.to(room.id).emit("game_ended", endedPayload(room, result, winner, finalized.eloChange));
        }
      }).catch(err => {
        logger.error("Game-over finalization failed", { error: err.stack });
        socket.emit("error", { message: "Unable to finalize game" });
      });
    });

    socket.on("resign", ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return;
      roomTask(room, async () => {
        if (room.status !== "playing") return;
        const caller = room.players.find(player => player.id === socket.id);
        if (!caller) return socket.emit("error", { message: "Not authorized" });
        const opponent = room.players.find(player => player.color !== caller.color);
        const finalized = await finalizeGameAtomic(room, "resign", opponent?.color || null);
        if (!finalized.settled) return;
        room.status = "finished";
        io.to(room.id).emit("game_ended", endedPayload(room, "resign", opponent?.name || null, finalized.eloChange));
      }).catch(() => socket.emit("error", { message: "Unable to resign" }));
    });

    socket.on("request_rematch", ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (room?.players.some(player => player.id === socket.id) && room.status === "finished") {
        socket.to(roomId).emit("rematch_requested");
      }
    });

    socket.on("accept_rematch", ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return;
      roomTask(room, async () => {
        if (room.status !== "finished" || !room.players.some(player => player.id === socket.id)) {
          return socket.emit("error", { message: "Not authorized" });
        }
        room.rematchVotes.add(socket.id);
        if (room.rematchVotes.size !== 2 || room.players.some(player => !player.id)) return;
        const switched = room.players.map(player => ({ ...player, color: player.color === "w" ? "b" : "w" }));
        const white = switched.find(player => player.color === "w");
        const black = switched.find(player => player.color === "b");
        const game = await Game.runInTransaction(async client => {
          const released = await client.query("UPDATE games SET room_id=NULL WHERE id=$1 AND status='finished'", [room.gameId]);
          if (released.rowCount !== 1) throw new Error("Rematch room release failed");
          const created = await Game.create({ roomId: room.id, whiteUserId: white.userId, whiteUsername: white.name }, client);
          await Game.joinBlackById(created.id, { blackUserId: black.userId, blackUsername: black.name }, client);
          return created;
        });
        room.gameId = game.id;
        room.players = switched;
        room.chess = new Chess(game.board_fen);
        room.board = room.chess.fen();
        room.turn = "w";
        room.moves = [];
        room.createdAt = Date.now();
        room.status = "playing";
        room.rematchVotes.clear();
        io.to(room.id).emit("game_start", { roomId: room.id, players: publicPlayers(room), turn: "w", boardState: room.board });
      }).catch(err => { logger.error("Rematch failed", { error: err.stack }); socket.emit("error", { message: "Unable to start rematch" }); });
    });

    socket.on("send_message", ({ roomId, text } = {}) => {
      const room = activeRooms.get(roomId);
      const player = room?.players.find(candidate => candidate.id === socket.id);
      const clean = String(text || "").slice(0, 200).trim();
      if (player && clean) io.to(roomId).emit("chat_message", { playerName: player.name, color: player.color, text: clean, time: Date.now() });
    });

    socket.on("leave_room", ({ roomId } = {}, acknowledge = () => {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return acknowledge({ left: true });
      roomTask(room, async () => {
        const player = room.players.find(candidate => candidate.id === socket.id);
        if (!player) return acknowledge({ error: "Not authorized" });
        if (room.status === "playing") {
          const opponent = room.players.find(candidate => candidate.color !== player.color);
          const finalized = await finalizeGameAtomic(room, "resign", opponent?.color || null);
          if (finalized.settled) {
            room.status = "finished";
            io.to(room.id).emit("game_ended", endedPayload(room, "resign", opponent?.name || null, finalized.eloChange));
          }
        }
        player.id = null;
        room.rematchVotes.delete(socket.id);
        socket.leave(room.id);
        acknowledge({ left: true });
      }).catch(error => {
        logger.error("Leave room failed", { error: error.stack });
        acknowledge({ error: "Unable to leave room" });
      });
    });

    socket.on("disconnect", () => {
      for (const room of activeRooms.values()) {
        const player = room.players.find(candidate => candidate.id === socket.id);
        if (!player) continue;
        roomTask(room, async () => {
          player.id = null;
          room.rematchVotes.delete(socket.id);
          if (room.status === "playing") socket.to(room.id).emit("opponent_disconnected");
          if (room.status === "finished" && room.players.every(candidate => !candidate.id)) activeRooms.delete(room.id);
        }).catch(error => logger.error("Disconnect state update failed", { error: error.stack }));
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

async function drainRoomOperations() {
  await Promise.allSettled([...activeRooms.values()].map(room => room.operation));
}

module.exports = {
  initSocket, activeRooms, rebuildActiveRooms, finalizeGameAtomic, persistMoveAtomic,
  touchedGameIds, drainRoomOperations, socketAuthentication,
};
