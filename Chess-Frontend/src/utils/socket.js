import { io } from "socket.io-client";
import { API } from "../api/client";
import { getStoredToken } from "./authStorage";

// ============================================================
// utils/socket.js — اتصال Socket.io واحد يتشارك فيه التطبيق كله
// بيتصل بشكل lazy أول ما حد يحتاجه فعلاً
//
// Authentication:
// - JWT is sent through Socket.IO handshake.auth
// - Backend verifies it once and binds the identity to socket.userId
// - No Socket event should send JWT tokens anymore
// ============================================================

let socket = null;

export const getSocket = () => {
  if (!socket) {
    socket = io(API, {
      autoConnect: false,
      transports: ["websocket", "polling"],

      // Read the latest token whenever Socket.IO connects/reconnects.
      auth: (cb) => {
        cb({
          token: getStoredToken(),
        });
      },
    });
  }

  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};
