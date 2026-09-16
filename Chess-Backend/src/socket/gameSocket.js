// ============================================================
// socket/gameSocket.js — Socket.io Multiplayer Handler
// Local Multiplayer: اللاعبان على نفس الجهاز
// ============================================================
const logger = require("../config/logger");
const jwt    = require("jsonwebtoken");
const Game   = require("../models/Game");
const Move   = require("../models/Move");
const User   = require("../models/User");
const { computeNewRatings } = require("../utils/elo");
const { Chess } = require("chess.js");

// الغرف النشطة (state حي في الميموري لسرعة اللعب)
// + بتتسجل بالتوازي في Postgres (games/moves) عشان متضعش لو السيرفر عمل restart
const activeRooms = new Map();

// لو الفرونت بعت JWT مع create_room/join_room بنعرف مين اللاعب فعليًا
// (لازم للـ ELO Rating System — متاح بس للاعبين المسجلين، الضيوف بيلعبوا عادي من غير تقييم)
const decodeUserId = (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "chess-secret-key");
    return decoded.id;
  } catch {
    return null;
  }
};

// تحديث الـ ELO للطرفين لو الاتنين لاعبين مسجلين (مش ضيوف) — بيرجع التغيير لو حصل
const settleElo = async (room, winnerColor) => {
  const white = room.players.find(p => p.color === "w");
  const black = room.players.find(p => p.color === "b");
  if (!white?.userId || !black?.userId) return null; // فيه ضيف — مفيش تقييم

  try {
    const [whiteUser, blackUser] = await Promise.all([User.findById(white.userId), User.findById(black.userId)]);
    if (!whiteUser || !blackUser) return null;

    const scoreWhite = winnerColor === "w" ? 1 : winnerColor === "b" ? 0 : 0.5;
    const [newWhiteElo, newBlackElo] = computeNewRatings(whiteUser.elo_rating, blackUser.elo_rating, scoreWhite);
    await Promise.all([User.updateElo(white.userId, newWhiteElo), User.updateElo(black.userId, newBlackElo)]);

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

    // ── إنشاء غرفة لعب جديدة ──────────────────────────────
    socket.on("create_room", async ({ playerName, token }) => {
      const userId = decodeUserId(token);
      const roomId = generateRoomId();
      activeRooms.set(roomId, {
        id:        roomId,
        players:   [{ id: socket.id, name: playerName, color: "w", userId }],
        board:     null,
        turn:      "w",
        status:    "waiting",
        moves:     [],
        createdAt: Date.now(),
        gameId:    null, // هيتحط بعد ما نسجّل السطر في Postgres
      });

      socket.join(roomId);
      socket.emit("room_created", { roomId, color: "w" });
      logger.info(`Room created: ${roomId} by ${playerName}`);

      // تسجيل اللعبة في DB (async — مش بيأخر بدء اللعب)
      try {
        const game = await Game.create({
          roomId,
          whiteUserId:   userId,
          whiteUsername: playerName,
          gameMode:      "multiplayer",
        });
        const room = activeRooms.get(roomId);
        if (room) {
          room.gameId = game.id;
          // Initialize server-side Chess instance and store initial FEN
          room.chess = new Chess();
          try {
            await Game.updateBoardFEN(roomId, room.chess.fen());
          } catch (err) {
            logger.error(`Failed to set initial board FEN for room ${roomId}: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error(`Failed to persist game for room ${roomId}: ${err.message}`);
      }
    });

    // ── الانضمام لغرفة ─────────────────────────────────────
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

      // Initialize server-side Chess instance from persisted FEN if needed
      if (!room.chess) {
        const dbGame = await Game.findByRoomId(roomId);
        if (dbGame && dbGame.board_fen) {
          room.chess = new Chess(dbGame.board_fen);
          room.board = dbGame.board_fen;
        } else {
          room.chess = new Chess();
        }
      }

      // إخبار كلا اللاعبين
      io.to(roomId).emit("game_start", {
        roomId,
        players: room.players,
        turn:    "w",
      });

      logger.info(`${playerName} joined room ${roomId}`);

      try {
        await Game.joinBlack(roomId, { blackUserId: userId, blackUsername: playerName });
      } catch (err) {
        logger.error(`Failed to persist black player for room ${roomId}: ${err.message}`);
      }
    });

    // ── تنفيذ حركة ─────────────────────────────────────────
    socket.on("make_move", async ({ roomId, move }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status !== "playing") return;

      // Verify correct player and turn
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.color !== room.turn) {
        return socket.emit("error", { message: "Not your turn" });
      }

      // Validate move with server-side chess engine
      const chess = room.chess;
      let chessMove;
      try {
        chessMove = chess.move({
          from: move.from,
          to: move.to,
          promotion: move.promotion,
        });
      } catch (err) {
        // Illegal or duplicate move throws – treat as invalid
        chessMove = null;
      }

      if (!chessMove) {
        return socket.emit("error", { message: "Illegal move" });
      }

      // Update turn based on chess state
      room.turn = chess.turn();

      // Update board FEN (canonical state)
      const fen = chess.fen();
      room.board = fen;

      // Persist move and board update atomically in a DB transaction
      const previousFEN = room.chess.fen(); // capture state before move for rollback
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
        // Transaction succeeded – update in‑memory state and notify clients
        room.turn = chess.turn();
        room.board = fen;
        room.moves.push({ move, player: player.color, time: Date.now() });
          // Check for automatic game over (checkmate or draw)
          if (chess.isCheckmate() || chess.isDraw()) {
            const derivedResult = chess.isCheckmate() ? "checkmate" : "draw";
            let derivedWinnerColor = null;
            let derivedWinner = null;
            if (derivedResult === "checkmate") {
              const winnerColor = room.turn === "w" ? "b" : "w";
              derivedWinnerColor = winnerColor;
              const winnerPlayer = room.players.find(p => p.color === winnerColor);
              derivedWinner = winnerPlayer?.name ?? null;
            }
            try {
              if (room.gameId) {
                await Game.finishById(room.gameId, { result: derivedResult, winnerColor: derivedWinnerColor });
              }
              const eloChange = await settleElo(room, derivedWinnerColor);
              room.status = "finished";
              io.to(roomId).emit("game_ended", {
                result: derivedResult,
                winner: derivedWinner,
                totalMoves: room.moves.length,
                duration: Math.floor((Date.now() - room.createdAt) / 1000),
                eloChange,
              });
            } catch (err) {
              logger.error(`Failed to finalize auto game_over for room ${roomId}: ${err.message}`);
              socket.emit("error", { message: "Failed to finalize game over" });
            }
            return;
          }
        io.to(roomId).emit("move_made", {
          move,
          boardState: fen,
          turn: room.turn,
          moveCount: room.moves.length,
        });
      } catch (err) {
        logger.error(`Failed to record move transaction for room ${roomId}: ${err.message}`);
        // Roll back in‑memory Chess state
        try { room.chess.load(previousFEN); } catch (_) {}
        socket.emit("error", { message: "Failed to record move" });
      }
    });

    // ── انتهاء اللعبة ──────────────────────────────────────
    // ── انتهاء اللعبة (authoritative) ──────────────────────────────────────
    socket.on("game_over", async ({ roomId, result, winner }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status === "finished") return;

      // Verify caller is a participant
      const caller = room.players.find(p => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for game_over" });
              // Require at least two moves before allowing manual game_over (unless auto‑detected)
              if (room.moves.length < 2) {
                return socket.emit("error", { message: "Game not over" });
              }

      // Derive authoritative result from chess engine
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
      // If the server does not recognize a game-over condition, reject the request
      if (derivedResult === "unknown") {
        return socket.emit("error", { message: "Game not over" });
      }


      // Ensure DB finish and Elo settlement succeed before emitting game_ended
      let eloChange = null;
      try {
        // Persist game finish to DB first (if applicable)
        if (room.gameId) {
          await Game.finishById(room.gameId, { result: derivedResult, winnerColor: derivedWinnerColor });
        }
        // Settle Elo after DB finish
        eloChange = await settleElo(room, derivedWinnerColor);
        // Mark as finished and broadcast
        room.status = "finished";
        io.to(roomId).emit("game_ended", {
          result: derivedResult,
          winner: derivedWinner,
          totalMoves: room.moves.length,
          duration: Math.floor((Date.now() - room.createdAt) / 1000),
          eloChange,
        });
      } catch (err) {
        logger.error(`Failed to finalize game_over for room ${roomId}: ${err.message}`);
        socket.emit("error", { message: "Failed to finalize game over" });
        return;
      }

      setTimeout(() => {
        activeRooms.delete(roomId);
        logger.info(`Room ${roomId} deleted`);
      }, 60000);

    });

    // ── طلب إعادة اللعب ────────────────────────────────────
    socket.on("request_rematch", ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      io.to(roomId).emit("rematch_requested");
    });

    socket.on("accept_rematch", async ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      // Verify caller is a participant
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
        // Notify participants of the failure without resetting state
        io.to(roomId).emit("error", { message: "Rematch failed to create new game" });
        // Do not modify room state; keep original game running
        return;
      }

      // DB transaction succeeded – now reset in‑memory state and broadcast
      room.rematchVotes = null;
      room.board = null;
      room.turn = "w";
      room.status = "playing";
      // Reset server‑side chess engine for new game
      room.chess = new Chess();
      room.moves = [];
      room.createdAt = Date.now();

      // Switch colors for both players
      room.players = room.players.map(p => ({
        ...p,
        color: p.color === "w" ? "b" : "w",
      }));

      // Emit game_start after state reset
      io.to(roomId).emit("game_start", {
        roomId,
        players: room.players,
        turn: "w",
      });
    });

        // ── طلب الاستسلام (Resign) ────────────────────────────────────────────────────────
    socket.on("resign", async ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      // Verify caller is a participant
      const caller = room.players.find(p => p.id === socket.id);
      if (!caller) return socket.emit("error", { message: "Not authorized for resign" });

      // Determine opponent and winner color
      const opponent = room.players.find(p => p.id !== socket.id);
      const winnerColor = opponent ? opponent.color : null;
      const derivedResult = "resign";
      const derivedWinner = opponent ? opponent.name : null;

      // Ensure DB finish and Elo settlement succeed before emitting game_ended
      let eloChange = null;
      try {
        // Persist finish to DB first
        if (room.gameId) {
          await Game.finishById(room.gameId, { result: derivedResult, winnerColor });
        }
        // Settle Elo after DB finish
        eloChange = await settleElo(room, winnerColor);
        // Emit game_ended
        io.to(roomId).emit("game_ended", {
          result: derivedResult,
          winner: derivedWinner,
          totalMoves: room.moves.length,
          duration: Math.floor((Date.now() - room.createdAt) / 1000),
          eloChange,
        });
        // Update room status after successful DB commit
        room.status = "finished";
      } catch (err) {
        logger.error(`Failed to finalize resign for room ${roomId}: ${err.message}`);
        socket.emit("error", { message: "Failed to finalize resign" });
        return;
      }

      // Schedule room cleanup after timeout (same as other exits)
      setTimeout(() => {
        activeRooms.delete(roomId);
        logger.info(`Room ${roomId} deleted`);
      }, 60000);

    });

    // ── الشات داخل الغرفة (Game Chat) ─────────────────────────
    socket.on("send_message", ({ roomId, text }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;

      const clean = String(text || "").slice(0, 200).trim(); // حد أقصى 200 حرف
      if (!clean) return;

      io.to(roomId).emit("chat_message", {
        playerName: player.name,
        color:      player.color,
        text:       clean,
        time:       Date.now(),
      });
    });

    // ── قطع الاتصال ────────────────────────────────────────
    socket.on("disconnect", async () => {
      logger.info(`Socket disconnected: ${socket.id}`);

      // ابحث عن الغرف التي ينتمي إليها هذا الـ socket
      for (const [roomId, room] of activeRooms.entries()) {
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
          if (room.status === "playing") {
            // إخبار اللاعب الآخر
            socket.to(roomId).emit("opponent_disconnected");

            if (room.gameId) {
              try {
                await Game.finishById(room.gameId, { result: "disconnect", winnerColor: null });
              } catch (err) {
                logger.error(`Failed to finish (disconnect) game for room ${roomId}: ${err.message}`);
              }
            }
          }
          activeRooms.delete(roomId);
          break;
        }
      }
    });
  });

  logger.info("✅ Socket.io initialized");
};

// توليد معرف غرفة فريد
const generateRoomId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

module.exports = { initSocket, activeRooms };
