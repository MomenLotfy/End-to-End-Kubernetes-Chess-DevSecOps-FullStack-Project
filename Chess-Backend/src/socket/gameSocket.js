// ============================================================
// socket/gameSocket.js — Socket.io Multiplayer Handler
<<<<<<< HEAD
// Server-authoritative: the client only ever sends *intent*
// ({ roomId, move: { from, to, promotion } }). Every fact about the
// game — legality, turn, board state, FEN, SAN, captures, checkmate,
// draw, winner, result and ELO — is derived and persisted server-side.
=======
// Local Multiplayer: two players on the same device
>>>>>>> fix/server-authoritative-game
// ============================================================
const logger = require("../config/logger");
const jwt = require("jsonwebtoken");
const Game = require("../models/Game");
const Move = require("../models/Move");
<<<<<<< HEAD
const { computeNewRatings } = require("../utils/elo");
const { Chess } = require("chess.js");

// Active rooms stored in memory for fast access. Every field that
// matters for gameplay (board, turn, status) is only ever advanced
// AFTER the corresponding Postgres transaction has committed — memory
// never runs ahead of the database.
=======
const User = require("../models/User");
const { computeNewRatings } = require("../utils/elo");
const { Chess } = require("chess.js");

// Active rooms stored in memory for fast access, also persisted in Postgres (games/moves)
>>>>>>> fix/server-authoritative-game
const activeRooms = new Map();

// Decode JWT to get user id (if provided)
const decodeUserId = (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "chess-secret-key");
    return decoded.id;
  } catch {
    return null;
  }
};

<<<<<<< HEAD
const cleanPlayerName = (name) => (typeof name === "string" ? name.trim().slice(0, 40) : "");

// Generate a unique room identifier
const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Schedule (non-authoritative) cleanup of a finished room's in-memory
// bookkeeping. This is bookkeeping housekeeping only — it never
// participates in deciding game outcome or in resolving any race; all
// of that is already settled by the time this timer is set.
const scheduleRoomCleanup = (roomId, delayMs = 60000) => {
  const timer = setTimeout(() => {
    activeRooms.delete(roomId);
    logger.info(`Room ${roomId} deleted`);
  }, delayMs);
  timer.unref();
};

// ------------------------------------------------------------------
// Atomic finalization: finish the game and (if both players are
// registered users) settle ELO, all inside a single Postgres
// transaction. Guarded against double finalization by:
//   1. an in-memory `room.finalizing` flag (checked synchronously
//      before the first await, so no two calls for the same room can
//      ever both pass the guard), and
//   2. the `status = 'in_progress'` condition inside
//      Game.finishByIdWithClient's UPDATE, which is the real,
//      transaction-safe guard against races across processes.
// game_ended is only ever emitted after the transaction commits.
// ------------------------------------------------------------------
async function finalizeGame(io, room, result, winnerColor, winner) {
  if (room.status === "finished" || room.finalizing) {
    throw new Error("ALREADY_FINALIZED");
  }
  room.finalizing = true;

  let finalization;
  try {
    finalization = await Game.runInTransaction(async (client) => {
      await Game.finishByIdWithClient(client, room.gameId, { result, winnerColor });

      const whitePlayer = room.players.find((p) => p.color === "w");
      const blackPlayer = room.players.find((p) => p.color === "b");
      let eloChange = null;

      // ELO only settles when both seats are still occupied by
      // registered users at finalization time. A disconnect removes
      // the disconnecting player from room.players before calling
      // this function specifically so that this branch is skipped —
      // disconnect never changes rating, by construction.
      if (whitePlayer?.userId && blackPlayer?.userId) {
        const whiteUser = await Game.getUserForUpdateWithClient(client, whitePlayer.userId);
        const blackUser = await Game.getUserForUpdateWithClient(client, blackPlayer.userId);
        const scoreWhite = winnerColor === "w" ? 1 : winnerColor === "b" ? 0 : 0.5;
        const [newWhiteElo, newBlackElo] = computeNewRatings(
          whiteUser.elo_rating,
          blackUser.elo_rating,
          scoreWhite
        );
        const updatedWhite = await Game.updateEloWithClient(client, whiteUser.id, newWhiteElo);
        const updatedBlack = await Game.updateEloWithClient(client, blackUser.id, newBlackElo);
        eloChange = {
          white: { username: whitePlayer.name, old: whiteUser.elo_rating, new: updatedWhite.elo_rating },
          black: { username: blackPlayer.name, old: blackUser.elo_rating, new: updatedBlack.elo_rating },
        };
      }

      return { eloChange };
    });
  } catch (err) {
    // Transaction failed (or rolled back): room stays exactly as it
    // was — still not finished — so it matches the database, and a
    // later action (another resign/game_over/disconnect) can retry.
    room.finalizing = false;
    throw err;
  }

  // Commit succeeded — now, and only now, advance authoritative memory.
  room.status = "finished";
  room.finalizing = false;

  io.to(room.id).emit("game_ended", {
    result,
    winner,
    totalMoves: room.moves.length,
    duration: Math.floor((Date.now() - room.createdAt) / 1000),
    eloChange: finalization.eloChange,
  });

  scheduleRoomCleanup(room.id);
  return finalization;
}

=======
// Atomic finalization helper: finish game and update ELO within a single DB transaction
const finalizeGameAtomic = async (room, result, winnerColor) => {
  // Ensure we have a persisted game ID
  if (!room.gameId) {
    throw new Error("Missing gameId for atomic finalization");
  }
  // Run all DB updates in one transaction using Game.runInTransaction
  const { eloChange } = await Game.runInTransaction(async (client) => {
    // Finish the game
    await client.query(
      `UPDATE games SET status='finished', result=$2, winner_color=$3, ended_at=CURRENT_TIMESTAMP WHERE id=$1`,
      [room.gameId, result, winnerColor]
    );

    // Prepare ELO change if both players are registered users
    const whitePlayer = room.players.find(p => p.color === "w");
    const blackPlayer = room.players.find(p => p.color === "b");
    let eloChange = null;
    if (whitePlayer?.userId && blackPlayer?.userId) {
      // Fetch current ratings within the transaction
      const whiteRes = await client.query(`SELECT id, elo_rating FROM users WHERE id=$1`, [whitePlayer.userId]);
      const blackRes = await client.query(`SELECT id, elo_rating FROM users WHERE id=$1`, [blackPlayer.userId]);
      const whiteUser = whiteRes.rows[0];
      const blackUser = blackRes.rows[0];
      if (whiteUser && blackUser) {
        const scoreWhite = winnerColor === "w" ? 1 : winnerColor === "b" ? 0 : 0.5;
        const [newWhiteElo, newBlackElo] = computeNewRatings(whiteUser.elo_rating, blackUser.elo_rating, scoreWhite);
        // Update ratings atomically
        await client.query(`UPDATE users SET elo_rating=$1 WHERE id=$2`, [newWhiteElo, whiteUser.id]);
        await client.query(`UPDATE users SET elo_rating=$1 WHERE id=$2`, [newBlackElo, blackUser.id]);
        eloChange = {
          white: { username: whitePlayer.name, old: whiteUser.elo_rating, new: newWhiteElo },
          black: { username: blackPlayer.name, old: blackUser.elo_rating, new: newBlackElo },
        };
      }
    }
    return { eloChange };
  });
  return eloChange;
};

// Settle ELO rating for both players if both are registered users (used in legacy paths)
const settleElo = async (room, winnerColor) => {
  const white = room.players.find(p => p.color === "w");
  const black = room.players.find(p => p.color === "b");
  if (!white?.userId || !black?.userId) return null; // Guest player – no rating

  try {
    const [whiteUser, blackUser] = await Promise.all([
      User.findById(white.userId),
      User.findById(black.userId),
    ]);
    if (!whiteUser || !blackUser) return null;

    const scoreWhite = winnerColor === "w" ? 1 : winnerColor === "b" ? 0 : 0.5;
    const [newWhiteElo, newBlackElo] = computeNewRatings(
      whiteUser.elo_rating,
      blackUser.elo_rating,
      scoreWhite
    );
    await Promise.all([
      User.updateElo(white.userId, newWhiteElo),
      User.updateElo(black.userId, newBlackElo),
    ]);
    return {
      white: { username: white.name, old: whiteUser.elo_rating, new: newWhiteElo },
      black: { username: black.name, old: blackUser.elo_rating, new: newBlackElo },
    };
  } catch (err) {
    logger.error(`ELO settlement failed for room ${room.id}: ${err.message}`);
    return null;
  }
};

>>>>>>> fix/server-authoritative-game
const initSocket = (io) => {
  io.on("connection", (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    // ── Create a new game room ────────────────────────
<<<<<<< HEAD
    socket.on("create_room", async ({ playerName, token } = {}) => {
      const cleanName = cleanPlayerName(playerName);
      if (!cleanName) {
        return socket.emit("error", { message: "Invalid player name" });
      }

      const userId = decodeUserId(token);
      const roomId = generateRoomId();
      const chess = new Chess();
      const initialFen = chess.fen();

      // Persist the game FIRST. room_created is only ever emitted after
      // this succeeds — there is no window where a client believes a
      // room exists that has no backing database row.
      let game;
      try {
        game = await Game.runInTransaction((client) =>
          Game.createWithClient(client, {
            roomId,
            whiteUserId: userId,
            whiteUsername: cleanName,
            gameMode: "multiplayer",
            initialFen,
          })
        );
=======
    socket.on("create_room", async ({ playerName, token }) => {
      const userId = decodeUserId(token);
      const roomId = generateRoomId();
      activeRooms.set(roomId, {
        id: roomId,
        players: [{ id: socket.id, name: playerName, color: "w", userId }],
        board: null,
        turn: "w",
        status: "waiting",
        moves: [],
        createdAt: Date.now(),
        gameId: null,
        finalizationFailed: false,
      });

      socket.join(roomId);
      socket.emit("room_created", { roomId, color: "w" });
      logger.info(`Room created: ${roomId} by ${playerName}`);

      // Persist the game in the database (async, does not block the start of play)
      try {
        const game = await Game.create({
          roomId,
          whiteUserId: userId,
          whiteUsername: playerName,
          gameMode: "multiplayer",
        });
        const room = activeRooms.get(roomId);
        if (room) {
          room.gameId = game.id;
          room.chess = new Chess();
          await Game.updateBoardFEN(roomId, room.chess.fen());
        }
>>>>>>> fix/server-authoritative-game
      } catch (err) {
        // Handle DB persistence failure: abort room creation
        socket.emit("error", { message: "Failed to persist game" });
        socket.leave(roomId);
        activeRooms.delete(roomId);
        logger.error(`Failed to persist game for room ${roomId}: ${err.message}`);
        return socket.emit("error", { message: "Failed to persist game" });
      }

      const room = {
        id: roomId,
        gameId: game.id,
        players: [{ id: socket.id, name: cleanName, color: "w", userId }],
        chess,
        turn: "w",
        status: "waiting",
        moves: [],
        createdAt: Date.now(),
        finalizing: false,
        rematchVotes: null,
      };
      activeRooms.set(roomId, room);
      socket.join(roomId);
      socket.emit("room_created", { roomId, color: "w" });
      logger.info(`Room created: ${roomId} by ${cleanName} (gameId=${game.id})`);
    });

    // ── Join an existing room ────────────────────────
<<<<<<< HEAD
    socket.on("join_room", async ({ roomId, playerName, token } = {}) => {
=======
    socket.on("join_room", async ({ roomId, playerName, token }) => {
>>>>>>> fix/server-authoritative-game
      const room = activeRooms.get(roomId);
      if (!room) {
        return socket.emit("error", { message: "Room not found" });
      }
      if (room.players.length >= 2) {
        return socket.emit("error", { message: "Room is full" });
      }
      if (room.status !== "waiting") {
        return socket.emit("error", { message: "Game already started" });
      }

      const cleanName = cleanPlayerName(playerName);
      if (!cleanName) {
        return socket.emit("error", { message: "Invalid player name" });
      }

      const userId = decodeUserId(token);

      // Persist FIRST. The WHERE clause (status='in_progress' AND
      // black_user_id IS NULL) is the real guard against two join_room
      // calls racing each other — Postgres serializes concurrent
      // UPDATEs on the same row, so at most one of them can match.
      try {
        await Game.runInTransaction((client) =>
          Game.joinBlackByIdWithClient(client, room.gameId, {
            blackUserId: userId,
            blackUsername: cleanName,
          })
        );
      } catch (err) {
        logger.error(`Failed to persist black player for room ${roomId}: ${err.message}`);
        return socket.emit("error", { message: "Failed to join game" });
      }

      // Re-check room capacity — protects against a second join_room
      // that raced in after the DB write above started but before this
      // point (it would have failed the DB write, but must not also be
      // allowed to mutate memory).
      if (room.players.length >= 2 || room.status !== "waiting") {
        return socket.emit("error", { message: "Room is full" });
      }

      room.players.push({ id: socket.id, name: cleanName, color: "b", userId });
      room.status = "playing";
      socket.join(roomId);

<<<<<<< HEAD
      io.to(roomId).emit("game_start", { roomId, players: room.players, turn: room.turn });
      logger.info(`${cleanName} joined room ${roomId}`);
    });

    // ── Execute a move ───────────────────────────────────
    socket.on("make_move", async ({ roomId, move } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status !== "playing") {
        return socket.emit("error", { message: "Game not in progress" });
      }
      if (room.finalizing) {
        return socket.emit("error", { message: "Game is finalizing" });
      }

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) {
        return socket.emit("error", { message: "Not authorized for make_move" });
      }
      if (player.color !== room.turn) {
        return socket.emit("error", { message: "Not your turn" });
      }
      if (!move || typeof move.from !== "string" || typeof move.to !== "string") {
        return socket.emit("error", { message: "Illegal move" });
      }

      // Capture full previous state BEFORE mutating the chess engine, so
      // a persistence failure can restore it exactly.
      const previousFen = room.chess.fen();
      const previousTurn = room.turn;

      let chessMove;
      try {
        chessMove = room.chess.move({
=======
      // Load or initialise the server‑side Chess instance
      if (!room.chess) {
        const dbGame = await Game.findByRoomId(roomId);
        if (dbGame && dbGame.board_fen) {
          room.chess = new Chess(dbGame.board_fen);
          room.board = dbGame.board_fen;
        } else {
          room.chess = new Chess();
        }
      }

      // Notify both participants that the game is ready
      // Emit game_start via setTimeout to allow listeners to attach
        io.to(roomId).emit("game_start", {
          roomId,
          players: room.players,
          turn: "w",
        });

      logger.info(`${playerName} joined room ${roomId}`);

      try {
        await Game.joinBlack(roomId, { blackUserId: userId, blackUsername: playerName });
      } catch (err) {
        logger.error(`Failed to persist black player for room ${roomId}: ${err.message}`);
      }
    });

    // ── Execute a move ───────────────────────────────────
    socket.on("make_move", async ({ roomId, move }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status !== "playing") return;

      // Verify player and turn
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.color !== room.turn) {
        return socket.emit("error", { message: "Not your turn" });
      }

      // Validate the move using the server‑side chess engine
      const chess = room.chess;
      let chessMove;
      try {
        chessMove = chess.move({
>>>>>>> fix/server-authoritative-game
          from: move.from,
          to: move.to,
          promotion: move.promotion,
        });
      } catch (_) {
        chessMove = null;
      }
<<<<<<< HEAD

      if (!chessMove) {
        // chess.js does not mutate state on a rejected move — nothing
        // to roll back.
        return socket.emit("error", { message: "Illegal move" });
      }

      // Everything below is derived from chess.js's own result, never
      // from anything the client sent (piece/captured/san/turn/etc. on
      // the incoming payload are never read).
      const newFen = room.chess.fen();
      const newTurn = room.chess.turn();
      const moveNumber = room.moves.length + 1;

      try {
        await Game.runInTransaction(async (client) => {
          await Game.updateBoardFENByIdWithClient(client, room.gameId, newFen);
          await Move.recordWithClient(client, {
            gameId: room.gameId,
            moveNumber,
            playerColor: chessMove.color,
            from: chessMove.from,
            to: chessMove.to,
            piece: chessMove.piece,
            capturedPiece: chessMove.captured ?? null,
            san: chessMove.san,
            fenAfter: newFen,
          });
        });
      } catch (err) {
        logger.error(`Failed to record move transaction for room ${roomId}: ${err.message}`);
        // Roll back the in-memory engine to the exact pre-move FEN.
        // room.turn/room.board/room.moves were never touched, so memory
        // matches the (unchanged) database exactly.
        room.chess.load(previousFen);
        return socket.emit("error", { message: "Failed to record move" });
      }

      // Commit succeeded — advance authoritative memory state.
      room.turn = newTurn;
      room.board = newFen;
      room.moves.push({
        from: chessMove.from,
        to: chessMove.to,
        piece: chessMove.piece,
        captured: chessMove.captured ?? null,
        san: chessMove.san,
        color: chessMove.color,
        player: player.color,
        time: Date.now(),
      });

      io.to(roomId).emit("move_made", {
        move: { from: chessMove.from, to: chessMove.to, promotion: chessMove.promotion ?? null },
        boardState: newFen,
        turn: room.turn,
        moveCount: room.moves.length,
      });

      // Terminal-state detection happens only after a committed move,
      // strictly from the server's own chess.js instance.
      if (room.chess.isCheckmate() || room.chess.isDraw()) {
        const derivedResult = room.chess.isCheckmate() ? "checkmate" : "draw";
        let derivedWinnerColor = null;
        let derivedWinner = null;
        if (derivedResult === "checkmate") {
          // The side that just moved (previousTurn) delivered mate.
          derivedWinnerColor = previousTurn;
          const winnerPlayer = room.players.find((p) => p.color === derivedWinnerColor);
          derivedWinner = winnerPlayer?.name ?? null;
        }
        try {
          await finalizeGame(io, room, derivedResult, derivedWinnerColor, derivedWinner);
        } catch (err) {
          logger.error(`Auto finalization failed for room ${roomId}: ${err.message}`);
          socket.emit("error", { message: "Failed to finalize game over" });
        }
      }
    });

    // ── Authoritative game over (client just asks the server to check) ───────
    socket.on("game_over", async ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) {
        return socket.emit("error", { message: "Room not found" });
      }

      const caller = room.players.find((p) => p.id === socket.id);
      if (!caller) {
        return socket.emit("error", { message: "Not authorized for game_over" });
      }
      if (room.status === "finished") {
        return socket.emit("error", { message: "Game already finished" });
      }
      if (room.finalizing) {
        return socket.emit("error", { message: "Game is finalizing" });
      }

      // The result is derived ENTIRELY from the server's chess.js state.
      // payload.result / payload.winner (if the client sent them) are
      // never read.
      const isCheckmate = room.chess.isCheckmate();
      const isDraw = room.chess.isDraw();

      if (!isCheckmate && !isDraw) {
        return socket.emit("error", { message: "Game not over" });
      }

      let derivedResult;
      let derivedWinnerColor = null;
      let derivedWinner = null;
      if (isCheckmate) {
        derivedResult = "checkmate";
        derivedWinnerColor = room.turn === "w" ? "b" : "w";
        const winnerPlayer = room.players.find((p) => p.color === derivedWinnerColor);
        derivedWinner = winnerPlayer?.name ?? null;
      } else {
        derivedResult = "draw";
      }

      try {
        await finalizeGame(io, room, derivedResult, derivedWinnerColor, derivedWinner);
      } catch (err) {
        logger.error(`Failed to finalize game_over for room ${roomId}: ${err.message}`);
        socket.emit("error", { message: "Failed to finalize game over" });
      }
    });

    // ── Request rematch ───────────────────────────────
    socket.on("request_rematch", ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return socket.emit("error", { message: "Room not found" });

      const caller = room.players.find((p) => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for request_rematch" });
      if (room.status !== "finished") return socket.emit("error", { message: "Game not finished" });

      io.to(roomId).emit("rematch_requested");
    });

    // ── Accept rematch ────────────────────────────────
    // `ack`, if provided by the client, is called with a deterministic
    // { ok, waitingForOpponent } result so a caller never has to guess
    // (via a timer) whether their vote was the deciding one.
    socket.on("accept_rematch", async ({ roomId } = {}, ack) => {
      const respond = typeof ack === "function" ? ack : () => {};

      const room = activeRooms.get(roomId);
      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return respond({ ok: false, error: "Room not found" });
      }

      const caller = room.players.find((p) => p.id === socket.id);
      if (!caller) {
        socket.emit("error", { message: "Not authorized for accept_rematch" });
        return respond({ ok: false, error: "Not authorized for accept_rematch" });
      }
      if (room.status !== "finished") {
        socket.emit("error", { message: "Rematch not available until game is finished" });
        return respond({ ok: false, error: "Rematch not available until game is finished" });
      }

      if (!room.rematchVotes) room.rematchVotes = new Set();
      room.rematchVotes.add(socket.id);

      if (room.players.length < 2 || room.rematchVotes.size < room.players.length) {
        return respond({ ok: true, waitingForOpponent: true });
      }

      // Both participants have voted — colors swap for the rematch.
      const nextWhite = room.players.find((p) => p.color === "b");
      const nextBlack = room.players.find((p) => p.color === "w");
      if (!nextWhite || !nextBlack) {
        room.rematchVotes = null;
        socket.emit("error", { message: "Both players must be present for a rematch" });
        return respond({ ok: false, error: "Both players must be present for a rematch" });
      }

      const chess = new Chess();
      const initialFen = chess.fen();

      // games.room_id is UNIQUE, so a rematch is a brand-new game row
      // (room_id = NULL), never a reuse of the finished game's roomId.
      let newGame;
      try {
        newGame = await Game.runInTransaction(async (client) => {
          const created = await Game.createWithClient(client, {
            roomId: null,
            whiteUserId: nextWhite.userId,
            whiteUsername: nextWhite.name,
            gameMode: "multiplayer",
            initialFen,
          });
          await Game.joinBlackByIdWithClient(client, created.id, {
            blackUserId: nextBlack.userId,
            blackUsername: nextBlack.name,
          });
          return created;
        });
      } catch (err) {
        logger.error(`Failed to persist rematch game for room ${roomId}: ${err.message}`);
        room.rematchVotes = null;
        io.to(roomId).emit("error", { message: "Rematch failed to create new game" });
        return respond({ ok: false, error: "Rematch failed to create new game" });
      }

      // Commit succeeded — now, and only now, reset authoritative memory.
      room.gameId = newGame.id;
      room.chess = chess;
      room.board = initialFen;
      room.turn = "w";
      room.status = "playing";
      room.moves = [];
      room.createdAt = Date.now();
      room.finalizing = false;
      room.rematchVotes = null;
      room.players = room.players.map((p) => ({
        ...p,
        color: p.id === nextWhite.id ? "w" : "b",
      }));

      io.to(roomId).emit("game_start", { roomId, players: room.players, turn: "w" });
      respond({ ok: true, waitingForOpponent: false });
    });

    // ── Resign ───────────────────────────────────────────────
    socket.on("resign", async ({ roomId } = {}) => {
      const room = activeRooms.get(roomId);
      if (!room) return socket.emit("error", { message: "Room not found" });

      const caller = room.players.find((p) => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for resign" });
      if (room.status === "finished") return socket.emit("error", { message: "Game already finished" });
      if (room.finalizing) return socket.emit("error", { message: "Game is finalizing" });

      const opponent = room.players.find((p) => p.id !== socket.id);
      const winnerColor = opponent ? opponent.color : null;
      const winner = opponent ? opponent.name : null;

      try {
        await finalizeGame(io, room, "resign", winnerColor, winner);
      } catch (err) {
        logger.error(`Failed to finalize resign for room ${roomId}: ${err.message}`);
        socket.emit("error", { message: "Failed to finalize resign" });
=======

      if (!chessMove) {
        return socket.emit("error", { message: "Illegal move" });
      }

      // Update turn and board state in memory
      room.turn = chess.turn();
      const fen = chess.fen();
      room.board = fen;
      logger.info(`Post‑move checkmate?=${room.chess.isCheckmate()}, draw?=${room.chess.isDraw()}`);

      // Persist move and board FEN atomically in a DB transaction
      const previousFEN = room.chess.fen(); // capture state before move for potential rollback
      try {
        await Game.runInTransaction(async (client) => {
          // Update board FEN
          await client.query(
            `UPDATE games SET board_fen = $2 WHERE room_id = $1 RETURNING *`,
            [roomId, fen]
          );
          // Record the move
          await client.query(
            `INSERT INTO moves (game_id, move_number, player_color, from_square, to_square, piece, captured_piece, san, fen_after)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              room.gameId,
              room.moves.length + 1,
              player.color,
              move?.from ?? "??",
              move?.to ?? "??",
              move?.piece ?? "??",
              move?.captured ?? null,
              move?.san ?? null,
              fen,
            ]
          );
        });

        // Set pending flag BEFORE emitting move_made to block client forged game_over
        if (room.chess.isCheckmate() || room.chess.isDraw()) {
          room.autoGameOverPending = true;
        }
        // No game over – record move and emit move_made
        room.moves.push({ move, player: player.color, time: Date.now() });
        logger.info(`Emitting move_made for room ${roomId}`);
        io.to(roomId).emit("move_made", {
            move,
            boardState: fen,
            turn: room.turn,
            moveCount: room.moves.length,
          });

        // Automatic game-over detection after a successful move
        if (room.chess.isCheckmate() || room.chess.isDraw()) {
          // Flag already set above; proceed with finalization
          const derivedResult = room.chess.isCheckmate() ? "checkmate" : "draw";
          let derivedWinnerColor = null;
          let derivedWinner = null;
          if (derivedResult === "checkmate") {
            const winnerColor = room.turn === "w" ? "b" : "w";
            derivedWinnerColor = winnerColor;
            const winnerPlayer = room.players.find(p => p.color === winnerColor);
            derivedWinner = winnerPlayer?.name ?? null;
          }
          if (room.status !== "finished" && !room.finalizationFailed) {
            try {
              if (room.gameId) {
                // Atomic finish + ELO update
                const eloChange = await finalizeGameAtomic(room, derivedResult, derivedWinnerColor);
                room.status = "finished";
                logger.info(`Auto game over detection: result=${derivedResult}, winner=${derivedWinner}`);
                io.to(roomId).emit("game_ended", {
                  result: derivedResult,
                  winner: derivedWinner,
                  totalMoves: room.moves.length,
                  duration: Math.floor((Date.now() - room.createdAt) / 1000),
                  eloChange,
                });
              } else {
                // Missing persisted game ID – cannot finalize atomically
                logger.error(`Missing gameId for room ${roomId} during auto finalization`);
                socket.emit("error", { message: "Game persistence missing; cannot finalize" });
                room.finalizationFailed = true;
              }
            } catch (err) {
              logger.error(`Failed to finalize game over for room ${roomId}: ${err.message}`);
              socket.emit("error", { message: "Failed to finalize game over" });
              room.finalizationFailed = true;
            }
            // Clear pending flag after automatic finalization (or if skipped)
            room.autoGameOverPending = false;
          }
                }
      } catch (err) {
        logger.error(`Failed to record move transaction for room ${roomId}: ${err.message}`);
        // Roll back in‑memory Chess state
        try { room.chess.load(previousFEN); } catch (_) {}
        socket.emit("error", { message: "Failed to record move" });
      }
    });

    // ── Authoritative game over (client request) ───────
    socket.on("game_over", async (payload) => {
      const { roomId } = payload;
      const room = activeRooms.get(roomId);
      if (!room || room.status === "finished") return;
          if (room.autoGameOverPending) {
            logger.info(`Ignored client game_over during auto finalization for room ${roomId}`);
            return;
          }
          // If the game is already a checkmate according to server state, ignore client attempts to override
          if (room.chess && room.chess.isCheckmate()) {
            logger.info(`Ignored client game_over on already checkmated game for room ${roomId}`);
            return;
          }

      // Verify caller is a participant
      const caller = room.players.find(p => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for game_over" });

      // Derive the result from the server‑side chess engine
      let derivedResult = "unknown";
      let derivedWinnerColor = null;
      let derivedWinner = null;
      if (room.chess) {
        logger.info(`Checking game over state: FEN=${room.chess.fen()} turn=${room.turn} isCheckmate=${room.chess.isCheckmate()} isDraw=${room.chess.isDraw()}`);
        if (room.chess.isCheckmate()) {
          derivedResult = "checkmate";
          const winnerColor = room.turn === "w" ? "b" : "w";
          derivedWinnerColor = winnerColor;
          const winnerPlayer = room.players.find(p => p.color === winnerColor);
          derivedWinner = winnerPlayer?.name ?? null;
        } else if (room.chess.isDraw()) {
          derivedResult = "draw";
        }
      }

      if (derivedResult === "unknown") {
        socket.emit("error", { message: "Game not over" });
        return;
      }

      // Ensure checkmate overrides any client‑provided result
      if (room.chess && room.chess.isCheckmate() && derivedResult !== "checkmate") {
        derivedResult = "checkmate";
        const winnerColor = room.turn === "w" ? "b" : "w";
        derivedWinnerColor = winnerColor;
        const winnerPlayer = room.players.find(p => p.color === winnerColor);
        derivedWinner = winnerPlayer?.name ?? null;
      }
      // Ensure any pending move processing completes before finalizing game_over
      await new Promise(r => setTimeout(r, 0));
      // If a previous automatic finalization failed, abort to avoid double finalize
      if (room.finalizationFailed) {
        logger.error(`Previous game finalization failed for room ${roomId}`);
        socket.emit("error", { message: "Failed to finalize game over" });
        return;
      }
      try {
        if (room.gameId) {
          const eloChange = await finalizeGameAtomic(room, derivedResult, derivedWinnerColor);
          io.to(roomId).emit("game_ended", {
            result: derivedResult,
            winner: derivedWinner,
            totalMoves: room.moves.length,
            duration: Math.floor((Date.now() - room.createdAt) / 1000),
            eloChange,
          });
          const deletionTimer = setTimeout(() => {
            activeRooms.delete(roomId);
            logger.info(`Room ${roomId} deleted`);
          }, 60000);
          deletionTimer.unref();
        } else {
          logger.error(`Missing gameId for room ${roomId} during client game_over`);
          socket.emit("error", { message: "Game persistence missing; cannot finalize" });
        }
      } catch (err) {
        logger.error(`Failed to finalize game_over for room ${roomId}: ${err.message}`);
        socket.emit("error", { message: "Failed to finalize game over" });
      }
    });

    // ── Request rematch ───────────────────────────────
    socket.on("request_rematch", ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;
      io.to(roomId).emit("rematch_requested");
    });

    // ── Accept rematch ────────────────────────────────
    socket.on("accept_rematch", async ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      const caller = room.players.find(p => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for accept_rematch" });

      // Track votes
      if (!room.rematchVotes) room.rematchVotes = new Set();
      room.rematchVotes.add(socket.id);
      if (room.rematchVotes.size < room.players.length) return; // wait for both

      try {
        const whitePlayer = room.players.find(p => p.color === "w");
        const blackPlayer = room.players.find(p => p.color === "b");
        const game = await Game.create({
          roomId: null, // new game not tied to old room ID
          whiteUserId: null,
          whiteUsername: whitePlayer?.name,
          gameMode: "multiplayer",
        });
        if (blackPlayer) {
          await Game.joinBlackById(game.id, { blackUserId: null, blackUsername: blackPlayer.name });
        }
        // Persist new game ID
        room.gameId = game.id;
      } catch (err) {
        logger.error(`Failed to persist rematch game for room ${roomId}: ${err.message}`);
        io.to(roomId).emit("error", { message: "Rematch failed to create new game" });
        room.rematchVotes = null;
        return;
      }

      // DB transaction succeeded – reset in‑memory state and broadcast
      room.rematchVotes = null;
      room.board = null;
      room.turn = "w";
      room.status = "playing";
      room.chess = new Chess();
      room.moves = [];
      room.createdAt = Date.now();

      // Switch colors for both players
      room.players = room.players.map(p => ({
        ...p,
        color: p.color === "w" ? "b" : "w",
      }));

      io.to(roomId).emit("game_start", {
        roomId,
        players: room.players,
        turn: "w",
      });
    });

    // ── Resign ───────────────────────────────────────────────
    socket.on("resign", async ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      const caller = room.players.find(p => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for resign" });

      const opponent = room.players.find(p => p.id !== socket.id);
      const winnerColor = opponent ? opponent.color : null;
      const derivedResult = "resign";
      const derivedWinner = opponent ? opponent.name : null;

      let eloChange = null;
      try {
        if (room.gameId) {
          // Perform atomic finish and ELO update
          eloChange = await finalizeGameAtomic(room, derivedResult, winnerColor);
        }
        // Emit game_ended after successful atomic finalization
        io.to(roomId).emit("game_ended", {
          result: derivedResult,
          winner: derivedWinner,
          totalMoves: room.moves.length,
          duration: Math.floor((Date.now() - room.createdAt) / 1000),
          eloChange,
        });
        room.status = "finished";
      } catch (err) {
        logger.error(`Failed to finalize resign for room ${roomId}: ${err.message}`);
        socket.emit("error", { message: "Failed to finalize resign" });
        return;
>>>>>>> fix/server-authoritative-game
      }

      const deletionTimer = setTimeout(() => {
        activeRooms.delete(roomId);
        logger.info(`Room ${roomId} deleted`);
      }, 60000);
      deletionTimer.unref();
    });

    // ── Chat inside room ───────────────────────────────────
<<<<<<< HEAD
    socket.on("send_message", ({ roomId, text } = {}) => {
=======
    socket.on("send_message", ({ roomId, text }) => {
>>>>>>> fix/server-authoritative-game
      const room = activeRooms.get(roomId);
      if (!room) return;

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) return;

      const clean = String(text || "").slice(0, 200).trim();
      if (!clean) return;

      io.to(roomId).emit("chat_message", {
        playerName: player.name,
        color: player.color,
        text: clean,
        time: Date.now(),
      });
    });

    // ── Disconnect handling ───────────────────────────────
    socket.on("disconnect", async () => {
      logger.info(`Socket disconnected: ${socket.id}`);

      for (const [roomId, room] of activeRooms.entries()) {
<<<<<<< HEAD
        const playerIdx = room.players.findIndex((p) => p.id === socket.id);
        if (playerIdx === -1) continue;

        if (room.status === "waiting") {
          // No game has started yet (single player in the room) — safe
          // to drop; nothing in the database needs reconciling.
          room.players.splice(playerIdx, 1);
          if (room.players.length === 0) {
            activeRooms.delete(roomId);
            logger.info(`Room ${roomId} deleted (empty, waiting)`);
          }
        } else if (room.status === "playing") {
          if (room.finalizing) {
            // A finalization (e.g. a checkmate that just landed) is
            // already committing — do not race it with a second one.
            break;
          }
          const remaining = room.players.find((p) => p.id !== socket.id);
          const winnerColor = remaining ? remaining.color : null;
          const winner = remaining ? remaining.name : null;

          // Remove the disconnecting player BEFORE finalizing. This is
          // what guarantees disconnect never changes ELO: finalizeGame
          // only settles ELO when both seats are occupied, and one seat
          // is now empty.
          room.players.splice(playerIdx, 1);
          socket.to(roomId).emit("opponent_disconnected");

          try {
            await finalizeGame(io, room, "disconnect", winnerColor, winner);
          } catch (err) {
            // If finalization fails, memory is deliberately left as-is
            // (still "playing", not "finished") so it keeps matching the
            // database's still-in_progress row, instead of marking the
            // room finished in memory only.
            logger.error(`Failed to finalize disconnect for room ${roomId}: ${err.message}`);
          }
        } else {
          // status === 'finished' — the game is already settled; only
          // bookkeeping remains.
          room.players.splice(playerIdx, 1);
=======
        const playerIdx = room.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== -1) {
          // Remove player from room
          room.players.splice(playerIdx, 1);
          if (room.status === "playing") {
            // Notify remaining player
            socket.to(roomId).emit("opponent_disconnected");
            if (room.gameId) {
              try {
                await Game.finishById(room.gameId, { result: "disconnect", winnerColor: null });
              } catch (err) {
                logger.error(`Failed to finish (disconnect) game for room ${roomId}: ${err.message}`);
              }
            }
            room.status = "finished";
            setTimeout(() => {
              activeRooms.delete(roomId);
              logger.info(`Room ${roomId} deleted`);
            }, 60000);
          } else if (room.players.length === 0) {
            // No players left – clean up
            activeRooms.delete(roomId);
            logger.info(`Room ${roomId} deleted (empty)`);
          }
          break;
>>>>>>> fix/server-authoritative-game
        }
        break;
      }
    });
  });
<<<<<<< HEAD
=======
};

// Generate a unique room identifier
const generateRoomId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
>>>>>>> fix/server-authoritative-game
};

module.exports = { initSocket, activeRooms };