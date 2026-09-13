// ============================================================
// server.js — Chess Backend Entry Point
// Express + Socket.io + PostgreSQL
// ============================================================
require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const helmet     = require("helmet");
const cors       = require("cors");
const morgan     = require("morgan");
const rateLimit  = require("express-rate-limit");

const { connectDB }       = require("./config/db");
const logger              = require("./config/logger");
const authRoutes          = require("./routes/auth");
const leaderboardRoutes   = require("./routes/leaderboard");
const gameRoutes          = require("./routes/game");
const friendsRoutes       = require("./routes/friends");
const tournamentRoutes    = require("./routes/tournaments");
const { initSocket }      = require("./socket/gameSocket");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET","POST"],
  },
});

// ─── Middleware ───────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(morgan("combined", { stream: { write: m => logger.info(m.trim()) } }));
app.use(express.json());

// ملفات الأفاتار المرفوعة (Avatar Upload) — لازم تكون accessible من الفرونت حتى لو على بورت مختلف
app.use("/uploads", (req, res, next) => { res.header("Cross-Origin-Resource-Policy", "cross-origin"); next(); }, express.static(require("path").join(__dirname, "..", "uploads")));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 دقيقة
  max: 100,                     // حد أقصى 100 طلب
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

// ─── Routes ──────────────────────────────────────────────
app.use("/api/auth",        authRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/game",        gameRoutes);
app.use("/api/friends",     friendsRoutes);
app.use("/api/tournaments", tournamentRoutes);

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error Handler
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message,
  });
});

// ─── Socket.io ───────────────────────────────────────────
initSocket(io);

// ─── Start Server ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    logger.info(`Chess Backend running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}).catch(err => {
  logger.error(`Database connection failed: ${err.message}`);
  process.exit(1);
});

module.exports = { app, server };
