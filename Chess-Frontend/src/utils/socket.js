import { io } from "socket.io-client";
import { API } from "../api/client";

// ============================================================
// utils/socket.js — اتصال Socket.io واحد يتشارك فيه التطبيق كله
// بيتصل بكسل (lazy) أول ما حد يحتاجه فعلاً، مش من أول ما الصفحة تفتح
// ============================================================
let socket = null;

export const getSocket = () => {
  if (!socket) {
    socket = io(API, { autoConnect: false, transports: ["websocket", "polling"] });
  }
  return socket;
};

export const disconnectSocket = () => {
  if (socket) { socket.disconnect(); socket = null; }
};
