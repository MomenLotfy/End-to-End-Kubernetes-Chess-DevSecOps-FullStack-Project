// ============================================================
// middleware/auth.js — JWT Authentication Middleware
// ============================================================
const jwt    = require("jsonwebtoken");
const logger = require("../config/logger");

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "chess-secret-key");
    req.user = decoded;
    next();
  } catch (err) {
    logger.warn(`Invalid token: ${err.message}`);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Middleware اختياري — لا يوقف الطلب إذا لم يكن هناك token
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "chess-secret-key");
  } catch {
    req.user = null;
  }
  next();
};

module.exports = { authMiddleware, optionalAuth };
