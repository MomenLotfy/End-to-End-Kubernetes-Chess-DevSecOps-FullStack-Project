// Wave 7 Phase 3 — dedicated Redis (Valkey) clients + lifecycle.
//
// THREE clients, never one shared connection for unrelated duties:
//   adapter-pub — socket.io adapter publishes fan-out here (plain commands OK)
//   adapter-sub — adapter's subscription side (client.duplicate(), sub-mode)
//   store       — application coordination commands (rematch votes now;
//               shared rate limiting in Phase 5)
// 3 TCP connections per pod, bounded and documented.
//
// Mode is EXPLICIT configuration (SOCKET_ADAPTER=local|redis, default local):
//   local — no clients, in-process adapter, in-memory rematch votes.
//           Single-replica development/test only.
//   redis — Valkey-backed adapter + Redis rematch votes. Missing host/auth,
//           or plaintext in production, is a FATAL startup error — the process
//           refuses to start rather than run degraded-and-silent.
// There is NO runtime fallback between modes: a redis-mode process whose
// cache is unreachable fails its consumers LOUDLY (metrics + controlled
// errors), never by quietly using local state.
//
// The password travels env -> ioredis option and NOWHERE else: it never
// appears in logs, metrics, error messages, /metrics, or describeConfig().
"use strict";

const IORedis = require("ioredis");
const logger = require("../config/logger");
const { onClientError, onReconnecting, collectConnected } = require("../metrics/redis");

const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;
const MAX_RETRIES_PER_REQUEST = 3;
const STARTUP_CONNECT_TIMEOUT_MS = 10000;
const SHUTDOWN_CLOSE_TIMEOUT_MS = 5000;

// Test seam: unit tests inject fakes; production always uses ioredis.
let clientFactoryOverride = null;
function setRedisClientFactoryForTests(factory) { clientFactoryOverride = factory || null; }
function redisClientFactory(options) {
  return clientFactoryOverride ? clientFactoryOverride(options) : new IORedis(options);
}

// Validated Redis configuration. Throws FATAL-prefixed errors (startup must
// abort) on any misconfiguration. NEVER includes the password in messages.
function redisConfig(env = process.env) {
  const mode = (env.SOCKET_ADAPTER || "local").toLowerCase();
  if (mode !== "local" && mode !== "redis") {
    throw new Error(`FATAL: SOCKET_ADAPTER must be local|redis (got ${mode})`);
  }
  if (mode === "local") return { mode };
  const host = env.REDIS_HOST;
  if (!host) throw new Error("FATAL: REDIS_HOST is required when SOCKET_ADAPTER=redis");
  const port = Number(env.REDIS_PORT || 6379);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("FATAL: REDIS_PORT must be a valid TCP port");
  }
  const tls = (env.REDIS_TLS ?? "true").toLowerCase() !== "false";
  if (!tls && env.NODE_ENV === "production") {
    throw new Error("FATAL: plaintext Redis is forbidden in production (REDIS_TLS=false refused)");
  }
  const password = env.REDIS_PASSWORD;
  if (!password) throw new Error("FATAL: REDIS_PASSWORD is required when SOCKET_ADAPTER=redis (ESO chess-redis)");
  return {
    mode,
    host,
    port,
    username: env.REDIS_USERNAME || "default",
    password,
    tls,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
  };
}

// Log-safe configuration summary: everything EXCEPT the password.
function describeConfig(config) {
  if (!config || config.mode !== "redis") return { mode: "local" };
  return {
    mode: "redis",
    host: config.host,
    port: config.port,
    username: config.username,
    tls: config.tls,
    authConfigured: true,
    connectTimeoutMs: config.connectTimeout,
    commandTimeoutMs: config.commandTimeout,
  };
}

function buildOptions(config) {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    // tls:{} = TLS with Node defaults (CA chain verified, SNI from host).
    // rejectUnauthorized stays true: ElastiCache presents a valid cert.
    tls: config.tls ? {} : undefined,
    connectTimeout: config.connectTimeout,
    commandTimeout: config.commandTimeout,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    enableReadyCheck: true,
    lazyConnect: true,
    keepAlive: 10000,
    // Bounded reconnect backoff: 100ms * attempts, capped at 3s. Reconnects
    // are counted (redis_reconnects_total) so a storm is visible, not silent.
    retryStrategy: times => Math.min(100 * times, 3000),
  };
}

// Attach error/reconnect telemetry. Handler bodies NEVER log options,
// configs, or error objects wholesale (ioredis errors can embed the command).
function instrumentClient(name, client) {
  client.on("error", error => {
    onClientError(name);
    logger.warn(`Redis client ${name} error`, { error: error?.message || "unknown" });
  });
  client.on("reconnecting", () => {
    onReconnecting(name);
    logger.warn(`Redis client ${name} reconnecting`);
  });
  client.on("ready", () => logger.info(`Redis client ${name} ready`));
  client.on("close", () => logger.warn(`Redis client ${name} connection closed`));
  collectConnected(name, () => (client.status === "ready" ? 1 : 0));
  return client;
}

// --- Process-wide singleton ------------------------------------------------
// Created once by initRedis() (server startup / createApplication). Tests
// reset via resetRedisForTests() between cases.
let holder = null;

function initRedis(env = process.env) {
  if (holder) return holder;
  const config = redisConfig(env);
  if (config.mode === "local") {
    logger.info("Socket adapter mode: local (single-replica, in-process)");
    holder = { mode: "local", config, clients: null };
    return holder;
  }
  logger.info("Socket adapter mode: redis", describeConfig(config));
  const options = buildOptions(config);
  const pub = instrumentClient("adapter-pub", redisClientFactory(options));
  // Library-supported duplication: sub inherits pub's options (TLS+AUTH).
  const sub = instrumentClient("adapter-sub", pub.duplicate());
  const store = instrumentClient("store", redisClientFactory(options));
  holder = { mode: "redis", config, clients: { pub, sub, store } };
  return holder;
}

function getRedis() {
  if (!holder) throw new Error("Redis accessed before initRedis()");
  return holder;
}

function redisMode() {
  return holder ? holder.mode : "local";
}

// Store-client liveness for /readiness: stateful, zero-cost (no command per
// probe). A half-open socket still reads ready until ioredis notices —
// accepted and documented: readiness ALSO fails on the next failed command
// path (rematch fail-closed), and kubelet re-probes every 10s.
function redisReady() {
  if (!holder || holder.mode !== "redis") return true;
  return holder.clients.store.status === "ready";
}

// The timer is cleared when the race SETTLES (not synchronously — a
// try/finally here would disarm the timeout before it could ever fire).
function withTimeout(promise, ms, what) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Startup gate (redis mode): prove endpoint+TLS+AUTH on ALL THREE clients
// before accepting traffic. Throws on failure — the process must not start
// "healthy" with a broken cache.
async function connectRedisOrFail() {
  const current = getRedis();
  if (current.mode !== "redis") return;
  const { pub, sub, store } = current.clients;
  try {
    await withTimeout(
      Promise.all([pub.connect(), sub.connect(), store.connect()]),
      STARTUP_CONNECT_TIMEOUT_MS,
      "Redis startup connect"
    );
    // AUTH/TLS prove-out: a bounded ping on the command client.
    await withTimeout(store.ping(), COMMAND_TIMEOUT_MS, "Redis startup ping");
  } catch (error) {
    throw new Error(`FATAL: Redis unavailable at startup (${error.message})`);
  }
}

// Shutdown: graceful quit with a bounded cap, then force-disconnect. Never
// throws (shutdown must proceed to pool cleanup even if Redis hangs).
// Returns an explicit result so the Phase 6 sequence can report whether the
// close was clean or forced (idempotent: a second call finds no holder and
// reports clean-local without touching anything).
async function closeRedisClients() {
  const current = holder;
  holder = null;
  if (!current || current.mode !== "redis") {
    return { closedClean: true, mode: current ? current.mode : "local" };
  }
  const clients = Object.values(current.clients);
  try {
    await withTimeout(
      Promise.allSettled(clients.map(client => client.quit())),
      SHUTDOWN_CLOSE_TIMEOUT_MS,
      "Redis quit"
    );
  } catch {
    for (const client of clients) {
      try { client.disconnect(); } catch { /* already gone */ }
    }
    logger.warn("Redis clients force-disconnected after quit timeout");
    return { closedClean: false, mode: "redis" };
  }
  logger.info("Redis clients closed");
  return { closedClean: true, mode: "redis" };
}

function resetRedisForTests() {
  holder = null;
  clientFactoryOverride = null;
}

module.exports = {
  CONNECT_TIMEOUT_MS, COMMAND_TIMEOUT_MS, MAX_RETRIES_PER_REQUEST,
  STARTUP_CONNECT_TIMEOUT_MS, SHUTDOWN_CLOSE_TIMEOUT_MS,
  redisConfig, describeConfig, buildOptions, withTimeout,
  initRedis, getRedis, redisMode, redisReady,
  connectRedisOrFail, closeRedisClients,
  setRedisClientFactoryForTests, resetRedisForTests,
};
