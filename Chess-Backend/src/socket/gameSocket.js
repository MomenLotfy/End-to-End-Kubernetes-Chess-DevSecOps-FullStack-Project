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
        if (room) room.gameId = game.id;
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
    socket.on("make_move", async ({ roomId, move, boardState, turn }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status !== "playing") return;

      // التحقق أن اللاعب الصحيح يحرك
      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.color !== room.turn) {
        return socket.emit("error", { message: "Not your turn" });
      }

      // تحديث حالة الغرفة
      room.board = boardState;
      room.turn  = turn;
      room.moves.push({ move, player: player.color, time: Date.now() });

      // إرسال الحركة لكلا اللاعبين
      io.to(roomId).emit("move_made", {
        move,
        boardState,
        turn,
        moveCount: room.moves.length,
      });

      // تسجيل الحركة في DB — أساس الـ Game Replay (Phase 2)
      // move المتوقع: { from, to, piece, captured, san } — لو الفرونت لسه
      // مبيبعتش الشكل ده، الحقول الناقصة بتتخزن NULL من غير ما تكسر اللعب
      if (room.gameId) {
        try {
          await Move.record({
            gameId:        room.gameId,
            moveNumber:    room.moves.length,
            playerColor:   player.color,
            from:          move?.from ?? "??",
            to:            move?.to ?? "??",
            piece:         move?.piece ?? "??",
            capturedPiece: move?.captured,
            san:           move?.san,
            fenAfter:      typeof boardState === "string" ? boardState : null,
          });
        } catch (err) {
          logger.error(`Failed to persist move in room ${roomId}: ${err.message}`);
        }
      }
    });

    // ── انتهاء اللعبة ──────────────────────────────────────
    socket.on("game_over", async ({ roomId, result, winner }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status === "finished") return; // الطرف التاني بلّغ عن نفس النتيجة خلاص
      room.status = "finished";

      const winnerColor = room.players.find(p => p.name === winner)?.color ?? null;
      const eloChange = await settleElo(room, winnerColor); // null لو فيه ضيف مش مسجل

      io.to(roomId).emit("game_ended", {
        result,
        winner,
        totalMoves: room.moves.length,
        duration:   Math.floor((Date.now() - room.createdAt) / 1000),
        eloChange,
      });

      if (room.gameId) {
        try {
          await Game.finishById(room.gameId, { result, winnerColor });
        } catch (err) {
          logger.error(`Failed to finish game for room ${roomId}: ${err.message}`);
        }
      }

      // حذف الغرفة بعد دقيقة
      setTimeout(() => {
        activeRooms.delete(roomId);
        logger.info(`Room ${roomId} deleted`);
      }, 60000);
    });

    // ── طلب إعادة اللعب ────────────────────────────────────
    socket.on("request_rematch", ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;
      socket.to(roomId).emit("rematch_requested");
    });

    socket.on("accept_rematch", async ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room) return;

      // إعادة تعيين الغرفة
      room.board  = null;
      room.turn   = "w";
      room.status = "playing";
      room.moves  = [];
      room.createdAt = Date.now();

      // تبديل الألوان
      room.players = room.players.map(p => ({
        ...p,
        color: p.color === "w" ? "b" : "w",
      }));

      io.to(roomId).emit("game_start", {
        roomId,
        players: room.players,
        turn: "w",
      });

      // لعبة جديدة = سطر جديد في games (الريماتش مش استكمال لنفس اللعبة)
      try {
        const whitePlayer = room.players.find(p => p.color === "w");
        const blackPlayer = room.players.find(p => p.color === "b");
        const game = await Game.create({
          roomId:        null, // room_id فريد؛ الغرفة القديمة استخدمته فعلاً
          whiteUserId:   null,
          whiteUsername: whitePlayer?.name,
          gameMode:      "multiplayer",
        });
        if (blackPlayer) {
          await Game.joinBlackById(game.id, { blackUserId: null, blackUsername: blackPlayer.name });
        }
        room.gameId = game.id;
      } catch (err) {
        logger.error(`Failed to persist rematch game for room ${roomId}: ${err.message}`);
      }
    });

    // ── الاستسلام ──────────────────────────────────────────
    socket.on("resign", async ({ roomId }) => {
      const room = activeRooms.get(roomId);
      if (!room || room.status === "finished") return;

      const resigningPlayer = room.players.find(p => p.id === socket.id);
      if (!resigningPlayer) return;

      const winner = room.players.find(p => p.id !== socket.id);
      room.status = "finished";

      const eloChange = await settleElo(room, winner?.color ?? null);

      io.to(roomId).emit("game_ended", {
        result:     "resign",
        winner:     winner?.name,
        totalMoves: room.moves.length,
        duration:   Math.floor((Date.now() - room.createdAt) / 1000),
        eloChange,
      });

      if (room.gameId) {
        try {
          await Game.finishById(room.gameId, { result: "resign", winnerColor: winner?.color ?? null });
        } catch (err) {
          logger.error(`Failed to finish (resign) game for room ${roomId}: ${err.message}`);
        }
      }
    });

    // ── شات داخل الغرفة (Game Chat) ─────────────────────────
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
