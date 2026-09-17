require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { connectDB, pool } = require("./config/db");
const { validateEnvironment } = require("./config/security");
const logger = require("./config/logger");
const { authMiddleware } = require("./middleware/auth");
const { originProtection } = require("./middleware/originProtection");
const authRoutes = require("./routes/auth");
const leaderboardRoutes = require("./routes/leaderboard");
const gameRoutes = require("./routes/game");
const friendsRoutes = require("./routes/friends");
const tournamentRoutes = require("./routes/tournaments");
const { initSocket, rebuildActiveRooms, drainRoomOperations } = require("./socket/gameSocket");

function buildCors(origins) {
  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) return callback(null, true);
      const error = new Error("Origin not allowed");
      error.status = 403;
      callback(error);
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
  };
}

function createApplication() {
  const { origins } = validateEnvironment();
  const app = express();
  const server = http.createServer(app);
  const corsOptions = buildCors(origins);
  const io = new Server(server, { cors: corsOptions });

  app.disable("x-powered-by");
  // The backend is ClusterIP-only behind the trusted frontend proxy/ingress.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", ...origins],
        connectSrc: ["'self'", ...origins],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  }));
  app.use(cors(corsOptions));
  app.use(cookieParser());
  app.use(express.json({ limit: "32kb" }));
  app.use(morgan("combined", { stream: { write: message => logger.info(message.trim()) } }));

  const globalLimiter = rateLimit({ windowMs: 15 * 60000, limit: 100, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: "Too many requests" } });
  const limiter = (windowMs, limit, message) => rateLimit({
    windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false,
    skipSuccessfulRequests: false, message: { error: message },
  });
  app.use("/api", globalLimiter);
  app.use("/api", originProtection(origins));
  app.use("/api/auth/login", limiter(60000, 5, "Too many authentication attempts"));
  app.use("/api/auth/register", limiter(15 * 60000, 5, "Too many registration attempts"));
  for (const route of ["resend-verification", "forgot-password"]) {
    app.use(`/api/auth/${route}`, limiter(15 * 60000, 3, "Too many email requests"));
  }
  app.use("/api/auth/reset-password", limiter(15 * 60000, 5, "Too many reset attempts"));
  app.use("/api/auth/refresh", limiter(60000, 30, "Too many refresh attempts"));

  app.use("/uploads", authMiddleware, express.static(path.join(__dirname, "..", "uploads"), {
    dotfiles: "deny", fallthrough: false, index: false, immutable: true, maxAge: "1h",
  }));
  app.use("/api/auth", authRoutes);
  app.use("/api/leaderboard", leaderboardRoutes);
  app.use("/api/game", gameRoutes);
  app.use("/api/friends", friendsRoutes);
  app.use("/api/tournaments", tournamentRoutes);
  app.locals.startupReady = false;
  app.locals.shuttingDown = false;
  app.get("/liveness", (req, res) => res.json({ status: "alive" }));
  app.get("/readiness", async (req, res) => {
    if (!app.locals.startupReady || app.locals.shuttingDown) return res.status(503).json({ status: "not-ready" });
    try {
      const check = await pool.query(
        `SELECT 1 FROM schema_migrations WHERE filename='007_fullstack_hardening.sql' AND checksum IS NOT NULL`
      );
      if (check.rowCount !== 1) return res.status(503).json({ status: "not-ready" });
      return res.json({ status: "ready" });
    } catch (error) {
      logger.warn("Readiness database check failed", { error: error.message });
      return res.status(503).json({ status: "not-ready" });
    }
  });
  app.get("/health", (req, res) => res.redirect(308, "/liveness"));
  app.use((req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((err, req, res, next) => {
    logger.error("Request failed", { error: err.stack, method: req.method, path: req.path });
    if (res.headersSent) return next(err);
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    const message = status === 404 ? "Resource not found" : status === 403 ? "Request rejected" : "Internal server error";
    res.status(status).json({ error: message });
  });
  initSocket(io);
  app.set("io", io);
  return { app, server, io };
}

async function connectWithRetry({ attempts = Number(process.env.DB_CONNECT_ATTEMPTS || 5), baseDelayMs = Number(process.env.DB_RETRY_BASE_MS || 250) } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { await connectDB(); return; } catch (err) {
      lastError = err;
      logger.error(`Database connection attempt ${attempt}/${attempts} failed`, { error: err.message });
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, Math.min(baseDelayMs * (2 ** (attempt - 1)), 5000)));
    }
  }
  throw lastError;
}

let shutdownPromise = null;
function closeHttp(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}

function installShutdownHandlers(application, { exit = code => process.exit(code) } = {}) {
  const shutdown = async (reason, error = null, exitCode = 0) => {
    if (shutdownPromise) return shutdownPromise;
    application.app.locals.shuttingDown = true;
    application.app.locals.startupReady = false;
    logger[error ? "error" : "info"](`Shutdown started: ${reason}`, error ? { error: error.stack || String(error) } : {});
    shutdownPromise = (async () => {
      await new Promise(resolve => application.io.close(resolve));
      await closeHttp(application.server);
      await drainRoomOperations();
      await pool.end();
      logger.info("Shutdown complete");
      exit(exitCode);
    })().catch(shutdownError => {
      logger.error("Shutdown failed", { error: shutdownError.stack });
      exit(1);
    });
    return shutdownPromise;
  };
  const onSigterm = () => { shutdown("SIGTERM", null, 0); };
  const onSigint = () => { shutdown("SIGINT", null, 0); };
  const onUncaught = error => { shutdown("uncaughtException", error, 1); };
  const onRejection = error => { shutdown("unhandledRejection", error instanceof Error ? error : new Error(String(error)), 1); };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  process.once("uncaughtException", onUncaught);
  process.once("unhandledRejection", onRejection);
  const uninstall = () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
  return { shutdown, uninstall };
}

async function assertMigrationsComplete() {
  const result = await pool.query(
    `SELECT filename, checksum FROM schema_migrations
     WHERE filename = ANY($1::text[]) ORDER BY filename`,
    [[
      "001_init.sql", "002_game_features.sql", "003_achievements.sql", "004_friends.sql",
      "005_tournaments.sql", "006_security_integrity.sql", "007_fullstack_hardening.sql",
    ]]
  );
  if (result.rowCount !== 7 || result.rows.some(row => !row.checksum)) {
    throw new Error("Database migrations are incomplete; run the migration service before the backend");
  }
}

async function startServer() {
  const application = createApplication();
  installShutdownHandlers(application);
  await connectWithRetry();
  await assertMigrationsComplete();
  await rebuildActiveRooms();
  const port = Number(process.env.PORT || 5000);
  await new Promise((resolve, reject) => {
    application.server.once("error", reject);
    application.server.listen(port, "0.0.0.0", resolve);
  });
  application.app.locals.startupReady = true;
  logger.info(`Chess Backend running on port ${port}`);
  return application;
}

if (require.main === module) {
  startServer().catch(async err => {
    logger.error("Fatal startup failure", { error: err.stack });
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { createApplication, startServer, connectWithRetry, assertMigrationsComplete, installShutdownHandlers, buildCors };
