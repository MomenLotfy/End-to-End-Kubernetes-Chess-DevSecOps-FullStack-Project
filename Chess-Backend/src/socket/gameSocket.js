// ============================================================
// socket/gameSocket.js — Socket.io Multiplayer Handler
// Local Multiplayer: two players on the same device
// ============================================================
const logger = require("../config/logger");
const jwt = require("jsonwebtoken");
const Game = require("../models/Game");
const Move = require("../models/Move");
const User = require("../models/User");
const { computeNewRatings } = require("../utils/elo");
const { Chess } = require("chess.js");

// Active rooms stored in memory for fast access, also persisted in Postgres (games/moves)
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

const initSocket = (io) => {
  io.on("connection", (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    // ── Create a new game room ────────────────────────
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
      } catch (err) {
        // Handle DB persistence failure: abort room creation
        socket.emit("error", { message: "Failed to persist game" });
        socket.leave(roomId);
        activeRooms.delete(roomId);
        logger.error(`Failed to persist game for room ${roomId}: ${err.message}`);
      }
    });

    // ── Join an existing room ────────────────────────
    socket.on("join_room", async ({ roomId, playerName, token }) => {
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

      const userId = decodeUserId(token);
      room.players.push({ id: socket.id, name: playerName, color: "b", userId });
      room.status = "playing";
      socket.join(roomId);

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
          from: move.from,
          to: move.to,
          promotion: move.promotion,
        });
      } catch (_) {
        chessMove = null;
      }

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
      }

      const deletionTimer = setTimeout(() => {
        activeRooms.delete(roomId);
        logger.info(`Room ${roomId} deleted`);
      }, 60000);
      deletionTimer.unref();
    });

    // ── Chat inside room ───────────────────────────────────
    socket.on("send_message", ({ roomId, text }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
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
        }
      }
    });
  });
};

// Generate a unique room identifier
const generateRoomId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

module.exports = { initSocket, activeRooms };