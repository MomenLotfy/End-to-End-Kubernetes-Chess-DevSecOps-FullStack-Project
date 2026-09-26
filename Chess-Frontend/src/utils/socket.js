import { io } from "socket.io-client";
import { API } from "../api/client";

let socket = null;
export const getSocket = () => {
  if (!socket) {
    socket = io(API || window.location.origin, {
      autoConnect: false,
      // Wave 7 Phase 4: websocket only, matching the server. Polling is
      // rejected server-side: multi-replica polling would need ALB
      // stickiness (per-process transport state), while one websocket per
      // client needs no affinity at all (see server.js transports note).
      transports: ["websocket"],
      withCredentials: true,
    });
  }
  return socket;
};
export const disconnectSocket = () => {
  if (socket) { socket.disconnect(); socket = null; }
};
