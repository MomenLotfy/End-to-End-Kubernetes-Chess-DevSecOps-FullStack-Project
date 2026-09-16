import { useState, useEffect, useRef, useCallback } from "react";
import { getSocket } from "../utils/socket";
import useChessGame from "./useChessGame";

// ============================================================
// hooks/useMultiplayer.js — Multiplayer الحقيقي (لاعبين، أجهزة مختلفة)
// بيربط useChessGame (نفس محرك اللعب المحلي) بأحداث Socket.io
// ============================================================
export default function useMultiplayer(myName, token) {
  const socketRef = useRef(null);
  const [phase, setPhase]     = useState("idle"); // idle | waiting | playing | ended
  const [roomId, setRoomId]   = useState(null);
  const [myColor, setMyColor] = useState(null);
  const [players, setPlayers] = useState([]);
  const [chat, setChat]       = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);
  const [endInfo, setEndInfo] = useState(null);
  const [rematchRequested, setRematchRequested] = useState(false); // أنا طلبت، مستني هو
  const [rematchOffered, setRematchOffered]     = useState(false); // هو طلب، مستني أنا

  // كل حركة أعملها محليًا (click أو doPromo) بتتبعت للسيرفر أول ما تتنفذ
  const onMoveCommitted = useCallback((moveEntry) => {
    if (!socketRef.current || !roomId) return;
    socketRef.current.emit("make_move", {
      roomId,
      move: {
        from: moveEntry.from,
        to: moveEntry.to,
        promotion: moveEntry.promotion,
      }
    });
  }, [roomId]);

  const game = useChessGame({ onMoveCommitted });
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    const s = getSocket();
    socketRef.current = s;
    if (!s.connected) s.connect();

    const onRoomCreated = ({ roomId, color }) => { setRoomId(roomId); setMyColor(color); setPhase("waiting"); };

    const onGameStart = ({ roomId: rid, players: pls, turn }) => {
      setRoomId(rid); setPlayers(pls); setPhase("playing"); setEndInfo(null);
      setOpponentDisconnected(false); setRematchOffered(false); setRematchRequested(false);
      gameRef.current.reset();
      const me = pls.find(p => p.name === myName);
      if (me) setMyColor(me.color);
    };

    const onMoveMade = ({ move }) => {
      gameRef.current.applyRemoteMove({ from: move.from, to: move.to, promotion: move.promotion });
    };

    const onGameEnded = (info) => { setEndInfo(info); setPhase("ended"); };
    const onOpponentDisconnected = () => setOpponentDisconnected(true);
    const onChatMessage = (msg) => setChat(c => [...c, msg]);
    const onErr = ({ message }) => setErrorMsg(message);
    const onRematchRequested = () => setRematchOffered(true);

    s.on("room_created", onRoomCreated);
    s.on("game_start", onGameStart);
    s.on("move_made", onMoveMade);
    s.on("game_ended", onGameEnded);
    s.on("opponent_disconnected", onOpponentDisconnected);
    s.on("chat_message", onChatMessage);
    s.on("error", onErr);
    s.on("rematch_requested", onRematchRequested);

    return () => {
      s.off("room_created", onRoomCreated);
      s.off("game_start", onGameStart);
      s.off("move_made", onMoveMade);
      s.off("game_ended", onGameEnded);
      s.off("opponent_disconnected", onOpponentDisconnected);
      s.off("chat_message", onChatMessage);
      s.off("error", onErr);
      s.off("rematch_requested", onRematchRequested);
    };
  }, [myName]);

  // لو اللعبة خلصت (كش مات/تعادل) محليًا — نبلّغ السيرفر (الطرفين بيبعتوا، السيرفر بيتحمل التكرار)
  useEffect(() => {
    if (!roomId || phase !== "playing") return;
    if (game.status === "checkmate" || game.status === "stalemate") {
      const loserColor = game.turn, winnerColor = loserColor === "w" ? "b" : "w";
      const winnerPlayer = players.find(p => p.color === winnerColor);
      socketRef.current?.emit("game_over", {
        roomId,
        result: game.status,
        winner: game.status === "checkmate" ? winnerPlayer?.name : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.status]);

  const createRoom = (name) => {
    setErrorMsg("");
    socketRef.current?.emit("create_room", { playerName: name });
  };

  const joinRoom = (rid, name) => {
    setErrorMsg("");
    setRoomId(rid);
    socketRef.current?.emit("join_room", {
      roomId: rid,
      playerName: name,
    });
  };
  const resign = () => socketRef.current?.emit("resign", { roomId });
  const requestRematch = () => { socketRef.current?.emit("request_rematch", { roomId }); setRematchRequested(true); };
  const acceptRematch = () => socketRef.current?.emit("accept_rematch", { roomId });
  const sendMessage = (text) => socketRef.current?.emit("send_message", { roomId, text });

  const leaveRoom = () => {
    socketRef.current?.disconnect();
    setPhase("idle"); setRoomId(null); setMyColor(null); setPlayers([]);
    setChat([]); setEndInfo(null); setOpponentDisconnected(false);
    setRematchOffered(false); setRematchRequested(false);
  };

  return {
    game, phase, roomId, myColor, players, chat, errorMsg, opponentDisconnected,
    endInfo, rematchRequested, rematchOffered,
    createRoom, joinRoom, resign, requestRematch, acceptRematch, sendMessage, leaveRoom,
  };
}
