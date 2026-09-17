import { io } from "socket.io-client";
import { API } from "../api/client";

let socket = null;
export const getSocket = () => {
  if (!socket) {
    socket = io(API || window.location.origin, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
  }
  return socket;
};
export const disconnectSocket = () => {
  if (socket) { socket.disconnect(); socket = null; }
};
