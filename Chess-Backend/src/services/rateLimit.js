// Wave 7 Phase 5: shared rate limiting. Single source of truth for the HTTP
// rate-limit inventory (limits / windows / messages / mount paths — mirrored
// in docs/security/rate-limits.md; the Wave 7 checker binds the two).
//
// Store selection is EXPLICIT at startup, never adaptive at runtime:
//   - local mode (dev/test/single-process): process-local MemoryStore, exactly
//     the pre-Phase-5 behavior.
//   - redis mode (staging/production): one RedisStore per limiter over the
//     shared Phase 3 `store` client (no new client, secret, endpoint, or DB).
// There is NO RUNTIME FALLBACK: when Redis is unavailable the RedisStore
// calls fail, express-rate-limit's passOnStoreError lets the request through
// (FAIL OPEN), and every degraded decision emits rate_limit_degraded_total +
// a structured warn log (LOUD). A MemoryStore is NEVER constructed on the
// redis path, in any handler, catch block, or retry — see §12 checks.
"use strict";

const rateLimit = require("express-rate-limit");
const { MemoryStore } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { withTimeout } = require("./redis");
const { rateLimitDegraded } = require("../metrics");
const logger = require("../config/logger");

// Fixed-window limiters, preserved verbatim from the pre-Phase-5 server.js
// wiring: same 7 scopes, same windows, same limits, same 429 bodies, same
// draft-7 headers. `route` is the Express mount path (server.js mounts in
// this order: global first, then the route limiters after originProtection).
// Key space: ratelimit:{name}:{clientIp} — fixed window per key, TTL =
// windowMs, set atomically with the first increment (Lua script inside
// rate-limit-redis; PTTL<=0 => SET key 1 PX windowMs, else INCR).
const GLOBAL_LIMITER_SPEC = Object.freeze({
  name: "global", route: "/api", windowMs: 15 * 60000, limit: 100,
  message: "Too many requests",
});
const ROUTE_LIMITER_SPECS = Object.freeze([
  Object.freeze({ name: "login", route: "/api/auth/login", windowMs: 60000, limit: 5, message: "Too many authentication attempts" }),
  Object.freeze({ name: "register", route: "/api/auth/register", windowMs: 15 * 60000, limit: 5, message: "Too many registration attempts" }),
  Object.freeze({ name: "resend-verification", route: "/api/auth/resend-verification", windowMs: 15 * 60000, limit: 3, message: "Too many email requests" }),
  Object.freeze({ name: "forgot-password", route: "/api/auth/forgot-password", windowMs: 15 * 60000, limit: 3, message: "Too many email requests" }),
  Object.freeze({ name: "reset-password", route: "/api/auth/reset-password", windowMs: 15 * 60000, limit: 5, message: "Too many reset attempts" }),
  Object.freeze({ name: "refresh", route: "/api/auth/refresh", windowMs: 60000, limit: 30, message: "Too many refresh attempts" }),
]);
const LIMITER_NAMES = new Set([GLOBAL_LIMITER_SPEC.name, ...ROUTE_LIMITER_SPECS.map(spec => spec.name)]);

// Bound on a single limiter Redis round trip. ElastiCache p99 is single-digit
// ms; 500ms is ~100x headroom and caps the added latency of the FIRST
// degraded request per limiter (~2 sequential timeouts worst case: the
// EVALSHA attempt plus the script-reload retry inside rate-limit-redis, after
// which the store's script-SHA promise stays rejected and subsequent
// increments fail instantly until Redis recovers). Requests behind a
// not-ready client never reach this timeout — they degrade instantly (below).
const RATE_LIMIT_REDIS_TIMEOUT_MS = 500;

// Fixed degradation reasons (chosen here, never derived from the underlying
// error — Redis error text can embed commands/keys and must never reach logs
// or metrics). `redis_not_ready` = client down/reconnecting (instant
// fail-open, no offline-queue buildup); `redis_command_failed` = a sent
// command failed or timed out (half-open socket, slow server, NOSCRIPT
// races — all collapse to fail-open + LOUD).
function onRateLimitDegraded(name, reason) {
  if (LIMITER_NAMES.has(name)) {
    rateLimitDegraded.inc({ limiter: name });
  }
  logger.warn("Rate limiting degraded: failing open (request allowed, not counted)", {
    limiter: name,
    reason,
  });
  // Fresh sanitized error: the original is dropped deliberately so neither
  // the key (client IP) nor the raw command can leak through this path.
  return new Error(`Rate limiting degraded (${name}/${reason}): failing open`);
}

async function sendLimiterCommand(name, storeClient, args) {
  if (!storeClient || storeClient.status !== "ready") {
    throw onRateLimitDegraded(name, "redis_not_ready");
  }
  try {
    return await withTimeout(
      storeClient.call(...args),
      RATE_LIMIT_REDIS_TIMEOUT_MS,
      "Rate limit Redis command",
    );
  } catch {
    throw onRateLimitDegraded(name, "redis_command_failed");
  }
}

function createRedisStore(name, storeClient) {
  const store = new RedisStore({
    sendCommand: (...args) => sendLimiterCommand(name, storeClient, args),
    prefix: `ratelimit:${name}:`,
  });
  // rate-limit-redis@4.3.1 fires SCRIPT LOAD in its constructor and keeps the
  // promises on these fields; the wrapper above rejects instantly while the
  // client is not ready (construction happens pre-connect), so without a sink
  // the rejections would crash the process (unhandledRejection). The shape is
  // asserted — never silently assumed — so a future store upgrade that moves
  // these fields fails CLOSED at startup instead of crashing at runtime.
  const loads = [store.incrementScriptSha, store.getScriptSha];
  if (loads.some(promise => !promise || typeof promise.catch !== "function")) {
    throw new Error("FATAL: rate-limit-redis store shape changed; refusing to start without the script-load rejection sink.");
  }
  for (const promise of loads) {
    promise.catch(() => {});
  }
  // Self-heal: the first real increment after connect reloads the scripts via
  // the store's retry path and counts normally (proven by tests).
  return store;
}

function createRateLimiters({ mode, store: storeClient } = {}) {
  if (mode !== "local" && mode !== "redis") {
    throw new Error("FATAL: createRateLimiters requires mode 'local' or 'redis'.");
  }
  if (mode === "redis" && !storeClient) {
    throw new Error("FATAL: createRateLimiters in redis mode requires the shared store client.");
  }
  const limiters = new Map();
  for (const spec of [GLOBAL_LIMITER_SPEC, ...ROUTE_LIMITER_SPECS]) {
    const store = mode === "redis"
      ? createRedisStore(spec.name, storeClient)
      : new MemoryStore();
    limiters.set(spec.name, rateLimit({
      windowMs: spec.windowMs,
      limit: spec.limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      message: { error: spec.message },
      store,
      // Redis mode fails OPEN on store errors (degraded + LOUD, never
      // blocking traffic); local mode keeps the library default (false) so a
      // store bug in dev/test surfaces loudly instead of hiding.
      passOnStoreError: mode === "redis",
    }));
  }
  return limiters;
}

module.exports = {
  GLOBAL_LIMITER_SPEC,
  ROUTE_LIMITER_SPECS,
  LIMITER_NAMES,
  RATE_LIMIT_REDIS_TIMEOUT_MS,
  createRateLimiters,
};
