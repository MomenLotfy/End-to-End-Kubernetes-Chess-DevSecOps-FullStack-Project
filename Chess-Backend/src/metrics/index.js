// Metric catalog (single source of truth). Every name/type/label set here is
// mirrored in docs/observability/telemetry-catalog.md — the Wave 6 static
// checks assert the two agree. No metric may carry identity (user, game,
// socket, token) or raw paths: see registry.js RESERVED_LABEL_NAMES.
"use strict";

const { Registry, Counter, Gauge, Histogram } = require("./registry");

const registry = new Registry();

// --- HTTP (labels: method x route-pattern x status-class — all bounded) ---
const httpRequestsTotal = registry.register(new Counter(
  "http_requests_total", "Completed HTTP requests.", ["method", "route", "status_class"]));
const httpRequestDuration = registry.register(new Histogram(
  "http_request_duration_seconds", "HTTP request duration in seconds.",
  ["method", "route", "status_class"]));
const httpRequestsInFlight = registry.register(new Gauge(
  "http_requests_in_flight", "HTTP requests currently being handled.", []));
const httpRequestSizeBytes = registry.register(new Histogram(
  "http_request_size_bytes", "HTTP request Content-Length in bytes (observed).",
  ["method", "route"],
  [256, 1024, 4096, 16384, 32768, 65536]));

// --- Application errors (component is a fixed enum: http|socket|db|mail|room) ---
const appErrorsTotal = registry.register(new Counter(
  "app_errors_total", "Application errors by component.", ["component"]));

// --- Runtime ---
const processUptime = registry.register(new Gauge(
  "process_uptime_seconds", "Process uptime in seconds.", []));
processUptime.collect({}, () => process.uptime());
const eventloopLag = registry.register(new Gauge(
  "eventloop_lag_seconds", "Event-loop delay beyond the 1s sampler tick.", []));

// --- Database (pool gauges sampled at scrape; no per-query labels) ---
const dbPoolConnections = registry.register(new Gauge(
  "db_pool_connections", "PostgreSQL pool connections by state.", ["state"]));
const dbQueryDuration = registry.register(new Histogram(
  "db_query_duration_seconds", "Database query duration in seconds.",
  ["operation"]));
const dbQueryErrors = registry.register(new Counter(
  "db_query_errors_total", "Failed database queries by operation.", ["operation"]));

// --- Socket.io (reasons are a bounded engine.io enum; unknown -> "other") ---
const socketConnects = registry.register(new Counter(
  "socket_io_connects_total", "Accepted Socket.io connections.", []));
const socketDisconnects = registry.register(new Counter(
  "socket_io_disconnects_total", "Socket.io disconnects by reason.", ["reason"]));
const socketAuthFailures = registry.register(new Counter(
  "socket_io_auth_failures_total", "Rejected Socket.io authentications.", []));
const socketConnectionsActive = registry.register(new Gauge(
  "socket_io_connections_active", "Currently connected sockets.", []));
const socketRoomsActive = registry.register(new Gauge(
  "socket_io_rooms_active", "Active game rooms held in process memory.", []));
const roomOperationFailures = registry.register(new Counter(
  "room_operation_failures_total", "Failed serialized room operations.", []));
// Wave 7 Phase 4: DB-truth room cache. Hydration outcomes are a fixed enum
// (created = cache miss materialized; refreshed = mutation-path re-sync;
// not_found = no live game for the room; invalid = malformed room id, no DB
// hit; error = DB fault or corrupt game abandoned). Presence outcomes are
// ok|failed (failed = adapter query fault/timeout, always fails closed).
const roomHydrations = registry.register(new Counter(
  "room_hydrations_total", "Room cache hydration/refresh outcomes.", ["outcome"]));
const presenceChecks = registry.register(new Counter(
  "presence_checks_total", "Cross-replica presence query outcomes.", ["outcome"]));

// --- Wave 7: S3 avatar object operations (operation/result are fixed enums) ---
const s3OperationsTotal = registry.register(new Counter(
  "s3_operations_total", "S3 avatar operations by operation and result.",
  ["operation", "result"]));
const s3OperationDuration = registry.register(new Histogram(
  "s3_operation_duration_seconds", "S3 avatar operation duration in seconds.",
  ["operation"], [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15]));
const s3LegacyFallbackReads = registry.register(new Counter(
  "s3_legacy_fallback_reads_total", "Avatar reads served from local disk because the S3 object is missing (migration window).", []));

// --- Wave 7 Phase 3: Redis coordination (client/command/operation = fixed enums) ---
const redisClientErrors = registry.register(new Counter(
  "redis_client_errors_total", "Redis client errors by dedicated client.", ["client"]));
const redisConnected = registry.register(new Gauge(
  "redis_connected", "Redis client ready state by dedicated client (1 = ready).", ["client"]));
const redisReconnects = registry.register(new Counter(
  "redis_reconnects_total", "Redis client reconnect attempts by dedicated client.", ["client"]));
const redisCommandDuration = registry.register(new Histogram(
  "redis_command_duration_seconds", "Redis command duration in seconds.",
  ["client", "command"], [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5]));
const rematchRedisErrors = registry.register(new Counter(
  "rematch_redis_errors_total", "Failed Redis-backed rematch operations.", ["operation"]));

// --- Wave 7 Phase 5: shared rate limiting (limiter is the fixed 7-name enum;
// NEVER an IP/client identity — degraded decisions carry no attribution) ---
const rateLimitDegraded = registry.register(new Counter(
  "rate_limit_degraded_total", "Rate-limit decisions failed open because Redis was unavailable (request allowed, not counted).", ["limiter"]));

// --- Wave 7 Phase 6: graceful shutdown (all labels are fixed enums;
// rejected work carries a source, never an identity) ---
const shutdownState = registry.register(new Gauge(
  "shutdown_state", "Shutdown lifecycle state (0=RUNNING, 1=DRAINING, 2=STOPPING, 3=STOPPED).", []));
const shutdownRejected = registry.register(new Counter(
  "shutdown_rejected_total", "Work rejected because the process is draining.", ["source"]));
const shutdownPhases = registry.register(new Counter(
  "shutdown_phase_total", "Shutdown phases by phase and result.", ["phase", "result"]));
const shutdownSignals = registry.register(new Counter(
  "shutdown_signals_total", "Shutdown trigger signals by signal and action.", ["signal", "action"]));

// --- Build identity (constant labels; enables version-correlated queries) ---
function buildInfo() {
  let version = "unknown";
  try { version = require("../../package.json").version || "unknown"; } catch { /* packed layout */ }
  const commit = process.env.GIT_SHA || "unknown";
  return { version: String(version).slice(0, 32), commit: String(commit).slice(0, 40) };
}
const buildInfoGauge = registry.register(new Gauge(
  "chess_build_info", "Build identity (constant 1).", ["version", "commit"]));

let buildInfoSet = false;
function renderMetrics() {
  if (!buildInfoSet) {
    const info = buildInfo();
    buildInfoGauge.set({ version: info.version, commit: info.commit }, 1);
    buildInfoSet = true;
  }
  return registry.exposition();
}

// Express route patterns only ("/api/game/:id"), never raw paths. Called at
// response-finish time, when req.route is populated (or absent -> unmatched).
function routeLabel(req) {
  const pattern = req.route && req.route.path ? `${req.baseUrl || ""}${req.route.path}` : "";
  if (!pattern) return "unmatched";
  return pattern.length > MAX_ROUTE_LABEL ? "unmatched" : pattern;
}
const MAX_ROUTE_LABEL = 128;

function statusClass(statusCode) {
  const code = Number(statusCode) || 0;
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "other";
}

module.exports = {
  registry, renderMetrics, routeLabel, statusClass,
  httpRequestsTotal, httpRequestDuration, httpRequestsInFlight, httpRequestSizeBytes,
  appErrorsTotal, processUptime, eventloopLag, dbPoolConnections, dbQueryDuration,
  dbQueryErrors, socketConnects, socketDisconnects, socketAuthFailures,
  socketConnectionsActive, socketRoomsActive, roomOperationFailures,
  roomHydrations, presenceChecks,
  s3OperationsTotal, s3OperationDuration, s3LegacyFallbackReads,
  redisClientErrors, redisConnected, redisReconnects, redisCommandDuration,
  rematchRedisErrors,
  rateLimitDegraded,
  shutdownState, shutdownRejected, shutdownPhases, shutdownSignals,
};
