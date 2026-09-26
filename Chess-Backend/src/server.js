require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const { connectDB, pool } = require("./config/db");
const { validateEnvironment } = require("./config/security");
const logger = require("./config/logger");
const { sanitizeUrl } = require("./config/logSanitize");
const { renderMetrics, appErrorsTotal } = require("./metrics");
const { metricsMiddleware, getInflightRequests } = require("./metrics/http");
const shutdown = require("./services/shutdown");
const { startRuntimeSampler } = require("./metrics/runtime");
const { authMiddleware } = require("./middleware/auth");
const { readAvatar, CONTENT_TYPE } = require("./services/avatarStore");
const { originProtection } = require("./middleware/originProtection");
const authRoutes = require("./routes/auth");
const leaderboardRoutes = require("./routes/leaderboard");
const gameRoutes = require("./routes/game");
const friendsRoutes = require("./routes/friends");
const tournamentRoutes = require("./routes/tournaments");
const { initSocket, rebuildActiveRooms, drainRoomOperations } = require("./socket/gameSocket");
const { initRedis, redisMode, redisReady, connectRedisOrFail, closeRedisClients } = require("./services/redis");
const { initRematchVotes } = require("./services/rematchVotes");
const { createRateLimiters, GLOBAL_LIMITER_SPEC, ROUTE_LIMITER_SPECS } = require("./services/rateLimit");

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
  const { origins, trustProxyHops } = validateEnvironment();
  const app = express();
  const server = http.createServer(app);
  const corsOptions = buildCors(origins);
  // Wave 7 Phase 4: websocket ONLY. Polling + multiple replicas REQUIRES
  // sticky sessions (Engine.IO transport state is per-process; the Redis
  // adapter syncs rooms/events, not transport state). One long-lived
  // websocket per client removes transport affinity entirely: the ALB
  // routes the HTTP upgrade once and never sees the client again, so no
  // stickiness knob, no pinned-to-draining-pod edge, no polling overhead.
  // ALB + frontend nginx already speak Upgrade (verified config); the
  // frontend pins transports:["websocket"] to match (utils/socket.js).
  const io = new Server(server, { cors: corsOptions, transports: ["websocket"] });
  // Wave 7 Phase 3: EXPLICIT fan-out mode (SOCKET_ADAPTER=local|redis).
  // local (default) = in-process adapter, single replica. redis = Valkey
  // adapter for cross-replica events (rooms/broadcasts ONLY — game truth
  // stays in PostgreSQL; activeRooms stays a per-replica cache, Phase 4).
  // Bad redis config throws FATAL here: the process refuses a silent local.
  const redis = initRedis();
  initRematchVotes(redis.mode === "redis"
    ? { mode: "redis", store: redis.clients.store }
    : { mode: "local" });
  if (redis.mode === "redis") {
    io.adapter(createAdapter(redis.clients.pub, redis.clients.sub));
  }

  app.disable("x-powered-by");
  // The backend is ClusterIP-only behind the trusted frontend proxy/ingress.
  // Validated above (FATAL on garbage): 1 is correct in compose (nginx) and
  // in EKS (nginx real_ip collapses ALB+nginx to one trusted hop).
  app.set("trust proxy", trustProxyHops);
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
  // Wave 6: per-request correlation ID (ADR-009: app emits request_id;
  // traceparent is propagated, never generated — no OTel SDK yet).
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    const traceparent = req.headers["traceparent"];
    if (typeof traceparent === "string" && /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)) {
      req.traceparent = traceparent;
      res.setHeader("traceparent", traceparent);
    }
    next();
  });
  // Access log: combined format + request ID, with URLs scrubbed (tokens in
  // query strings / JWT-like path segments never reach Loki). Bodies, cookies
  // and auth headers are never logged by morgan at all.
  morgan.token("req-id", req => req.id || "-");
  morgan.token("sanitized-url", req => sanitizeUrl(req.originalUrl || req.url || ""));
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :sanitized-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" req_id=:req-id', { stream: { write: message => logger.info(message.trim()) } }));
  app.use(metricsMiddleware);

  // Wave 7 Phase 6: graceful-shutdown admission. The preStop trigger is
  // registered BEFORE the limiters (draining must never 429) and the drain
  // gate sits between metrics and limiters (rejected work skips rate-limit
  // Redis commands entirely). Both are mounted before every route below.
  app.get("/internal/enter-drain", shutdown.createEnterDrainHandler(app));
  app.use(shutdown.createDrainGateMiddleware());

  // Wave 7 Phase 5: shared rate limiting. Limits/windows/messages/mounts are
  // specified once in services/rateLimit (mirrored in docs/security/
  // rate-limits.md). Local mode = process-local MemoryStore (dev/test only);
  // redis mode = RedisStores over the shared Phase 3 `store` client with
  // fail-open + LOUD on Redis faults (never a runtime MemoryStore fallback).
  // Mount order is unchanged: global first, then originProtection, then the
  // six route limiters.
  const limiters = createRateLimiters(redis.mode === "redis"
    ? { mode: "redis", store: redis.clients.store }
    : { mode: "local" });
  app.use(GLOBAL_LIMITER_SPEC.route, limiters.get(GLOBAL_LIMITER_SPEC.name));
  app.use("/api", originProtection(origins));
  for (const spec of ROUTE_LIMITER_SPECS) {
    app.use(spec.route, limiters.get(spec.name));
  }

  // Wave 7: avatars are served from the configured store (local disk | private
  // S3) through this authenticated handler — never via express.static and
  // never via public/presigned URLs. Filenames are content-unique (uuid), so
  // immutable 1h caching is preserved from the old static config.
  app.get("/uploads/avatars/:filename", authMiddleware, async (req, res) => {
    try {
      const found = await readAvatar(req.params.filename);
      if (!found) return res.status(404).json({ error: "Resource not found" });
      res.setHeader("Content-Type", CONTENT_TYPE);
      res.setHeader("Content-Length", String(found.size));
      res.setHeader("Cache-Control", "private, max-age=3600, immutable");
      if (found.etag) res.setHeader("ETag", found.etag);
      res.send(found.body);
    } catch (error) {
      logger.error("Avatar read failed", { error: error.message });
      res.status(500).json({ error: "Unable to read avatar" });
    }
  });
  app.use("/api/auth", authRoutes);
  app.use("/api/leaderboard", leaderboardRoutes);
  app.use("/api/game", gameRoutes);
  app.use("/api/friends", friendsRoutes);
  app.use("/api/tournaments", tournamentRoutes);
  app.locals.startupReady = false;
  app.locals.shuttingDown = false;
  app.get("/liveness", (req, res) => res.json({ status: "alive" }));
  // Wave 6: Prometheus exposition. Same port (no new listener), excluded from
  // access metrics, never rate-limited (outside /api), unreachable from the
  // internet (nginx proxies only /api|/uploads|/socket.io; netpol allows only
  // Alloy + frontend + kubelet). Failures here can NEVER affect liveness.
  app.get("/metrics", (req, res) => {
    try {
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(renderMetrics());
    } catch (error) {
      logger.error("Metrics exposition failed", { error: error.message });
      res.status(500).end();
    }
  });
  app.get("/readiness", async (req, res) => {
    // Wave 7 Phase 6: readiness fails the instant DRAINING begins (the
    // preStop trigger flips this before sleeping, so endpoints propagate
    // while the pod still drains). Liveness is untouched below.
    if (!app.locals.startupReady || app.locals.shuttingDown || shutdown.isDraining()) {
      return res.status(503).json({ status: "not-ready" });
    }
    // Wave 7 Phase 3: in redis mode the cache is MANDATORY — an unready
    // store client fails readiness via zero-cost connection STATE (no Redis
    // command per probe, no probe timeout risk). Liveness never depends here.
    if (redisMode() === "redis" && !redisReady()) {
      return res.status(503).json({ status: "not-ready" });
    }
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
    logger.error("Request failed", { error: err.stack, method: req.method, path: req.path, requestId: req.id });
    if (res.headersSent) return next(err);
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) {
      try { appErrorsTotal.inc({ component: "http" }); } catch { /* drop */ }
    }
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

// Wave 7 Phase 6: shutdown lives in services/shutdown.js (bounded state
// machine, single CAS controller). server.js only injects the production
// dependencies — the HTTP server, Socket.IO server, in-flight gauge,
// bounded room drain, coordination-client close, and pool end — and keeps
// the historical export shape (existing tests + startServer unchanged).
function installShutdownHandlers(application, options = {}) {
  return shutdown.installShutdownHandlers(application, {
    getInflight: getInflightRequests,
    drainRooms: budgetMs => drainRoomOperations(budgetMs),
    closeCache: () => closeRedisClients(),
    closePool: () => pool.end(),
    ...options,
  });
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
  startRuntimeSampler();
  await connectWithRetry();
  // Wave 7 Phase 3: in redis mode, prove endpoint+TLS+AUTH on all three
  // clients BEFORE serving (throws FATAL on failure — no silent local).
  // In local mode this is a no-op.
  await connectRedisOrFail();
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
