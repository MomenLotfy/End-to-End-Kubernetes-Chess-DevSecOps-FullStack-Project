const jwt = require("jsonwebtoken");

const socketAuthMiddleware = (socket, next) => {
  const token = socket.handshake.auth?.token;

  // Guest connection is allowed.
  if (!token) {
    socket.userId = null;
    socket.authenticated = false;
    return next();
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "chess-secret-key"
    );

    if (!decoded?.id) {
      return next(new Error("Invalid authentication token"));
    }

    socket.userId = decoded.id;
    socket.authenticated = true;

    return next();
  } catch (err) {
    return next(new Error("Invalid authentication token"));
  }
};

module.exports = { socketAuthMiddleware };
