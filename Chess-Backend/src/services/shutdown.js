// Wave 7 Phase 6 — bounded deterministic graceful shutdown.
//
// State machine: RUNNING -> DRAINING -> STOPPING -> STOPPED.
// Sequence: DRAINING -> settle -> HTTP drain -> room drain -> Socket.IO
// close -> coordination-client close -> PostgreSQL pool close -> exit.
//
// Ordering rationale (each edge is load-bearing):
//   HTTP before rooms: HTTP holds no room locks; finish fast requests first.
//   Rooms before sockets: in-flight chess ops complete while opponent
//     sockets are still connected, so result emits still deliver.
//   Sockets before the client bundle: no socket teardown may touch clients
//     that are already closing (the room gate rejects anyway; ordering
//     removes the dependency instead of racing it).
//   Clients before PostgreSQL: PG is the chess-state authority and closes
//     LAST, so abandoned-but-running transactions get every chance to
//     commit or roll back cleanly.
//
// HTTP / Socket.IO coupling (verified against the installed Socket.IO):
// the attached server is closed EXACTLY once, inside the single deliberate
// Socket.IO close call below. Application code never invokes the HTTP
// close method
// directly — there is no second close, hence no double-close catch path.
// New work is stopped at the app layer (gates) while the listener stays
// open; idle keep-alive connections are destroyed proactively (before and
// during io.close via an unref'd sweep) so the library-internal close
// callback has nothing to wait for; only stragglers past the socket
// deadline are force-destroyed (a socket primitive, not a second close).
//
// Budget (Kubernetes grace stays 30s, see values.yaml):
//   preStop trigger + sleep: 5s (Helm lifecycle, outside this file)
//   application global cap: 22s (watchdog below, exits 1 on fire)
//   SIGKILL margin: 3s
// Phase caps sum to 21s + 1s slack = 22s. Every phase is clamped to the
// remaining global budget. Per-phase timeout/force is ROUTINE (exit 0);
// only the watchdog, a sequence internal error, or a crash exits 1.
//
// Wording note: the Phase 3 coordination-client bundle is called "cache"
// in this file (metric phase label included). The close function arrives
// injected from server.js, which keeps this module free of transport,
// store, and pool requires (no import cycles, deterministic fakes).
"use strict";

const logger = require("../config/logger");
const {
  setShutdownState, onRejectedWork, onPhase, onSignal,
} = require("../metrics/shutdown");

const STATES = { RUNNING: 0, DRAINING: 1, STOPPING: 2, STOPPED: 3 };
const STATE_NAMES = ["RUNNING", "DRAINING", "STOPPING", "STOPPED"];

// PreStop trigger + propagation sleep (Helm lifecycle; documented here so
// the 30s accounting lives next to the caps it constrains).
const PRESTOP_MS = 5000;
// Application global cap after SIGTERM. Watchdog exits 1 past this.
const GLOBAL_BUDGET_MS = 22000;
// Endpoint-propagation settle at sequence start (uniform across k8s,
// compose, and degraded-preStop environments).
const SETTLE_MS = 2000;
// Express in-flight wait (Engine.IO transports bypass Express tracking and
// end at the socket phase instead — never waited on here).
const HTTP_MS = 3000;
// Room-chain snapshot drain (abandon, never cancel, past the cap).
const ROOM_MS = 6000;
// Socket phase: bounded io.close race, then a short force settle.
const SOCKET_MS = 2000;
const SOCKET_RACE_MS = 1500;
const SOCKET_SETTLE_MS = 500;
// Coordination-client bundle close (quit-then-force inside the service).
const CACHE_MS = 5000;
// PostgreSQL pool end (called exactly once; capped, never retried).
const PG_MS = 3000;
// Idle keep-alive sweep cadence during io.close (unref'd).
const IDLE_SWEEP_MS = 100;
// In-flight poll cadence during the HTTP phase.
const HTTP_POLL_MS = 25;

// Controlled rejection for work admitted after DRAINING began. Callers
// receive this (never a silent drop); every roomTask caller already has a
// rejection path, proven by trace.
class ShutdownDrainError extends Error {
  constructor() {
    super("Server shutting down");
    this.name = "ShutdownDrainError";
    this.code = "SHUTDOWN_DRAINING";
  }
}

function isShutdownDrainError(error) {
  return !!error && error.name === "ShutdownDrainError" && error.code === "SHUTDOWN_DRAINING";
}

// --- Module state (single controller per process) ---------------------------
let currentState = STATES.RUNNING;
let prestopSeen = false;
let sequencePromise = null;
let poolEnded = false;
let drainStartedAt = null;

setShutdownState(STATES.RUNNING);

function setState(next) {
  currentState = next;
  setShutdownState(next);
}

function getShutdownState() {
  return currentState;
}

function getShutdownStateName() {
  return STATE_NAMES[currentState] || "UNKNOWN";
}

function isDraining() {
  return currentState !== STATES.RUNNING;
}

function isSequenceStarted() {
  return sequencePromise !== null;
}

function getShutdownInfo() {
  return {
    state: currentState,
    stateName: getShutdownStateName(),
    prestopSeen,
    sequenceStarted: sequencePromise !== null,
    poolEnded,
    drainStartedAt,
  };
}

function resetShutdownForTests() {
  currentState = STATES.RUNNING;
  prestopSeen = false;
  sequencePromise = null;
  poolEnded = false;
  drainStartedAt = null;
  setShutdownState(STATES.RUNNING);
}

// Idempotent flag flip. May be called from the preStop endpoint (which must
// NEVER run phases) or from the sequence runner (which ensures DRAINING
// when preStop was skipped or failed). Returns true on the transition.
function enterDraining(source, { app } = {}) {
  if (currentState !== STATES.RUNNING) return false;
  if (source === "prestop") prestopSeen = true;
  drainStartedAt = Date.now();
  if (app && app.locals) app.locals.shuttingDown = true;
  setState(STATES.DRAINING);
  logger.info("Shutdown entering DRAINING", { source: String(source || "unknown").slice(0, 32) });
  return true;
}

// --- Socket-management primitives (never a second close) --------------------
function closeIdle(server) {
  try {
    if (server && typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  } catch { /* a wedged socket must not break the sequence */ }
}

function closeAll(server) {
  try {
    if (server && typeof server.closeAllConnections === "function") server.closeAllConnections();
  } catch { /* forcedestroy is best-effort by definition */ }
}

function startIdleSweep(server) {
  try {
    const timer = setInterval(() => closeIdle(server), IDLE_SWEEP_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  } catch {
    return null;
  }
}

function stopIdleSweep(timer) {
  try {
    if (timer) clearInterval(timer);
  } catch { /* drop */ }
}

// --- Deadline helpers (real timers; outcomes never depend on tight races) --
function withDeadline(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(false);
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function withValueDeadline(promise, ms, fallback) {
  if (!(ms > 0)) return Promise.resolve(fallback);
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(value => value, () => fallback),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorText(error) {
  if (!error) return "unknown";
  if (typeof error === "string") return error.slice(0, 256);
  return String(error.message || error).slice(0, 256);
}

// --- The single deliberate Socket.IO close path -----------------------------
// Exactly one call site in the process. Tolerant of both shapes: the real
// server (async close resolving a promise) and callback-style doubles.
// Never rejects: a broken io object degrades to the force path, never to a
// stuck sequence.
function closeIoOnce(io) {
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const outstanding = io.close(done);
      if (outstanding && typeof outstanding.then === "function") outstanding.then(done, done);
    } catch {
      done();
    }
  });
}

// --- Admission gates (new work stops while the listener stays open) ---------
const DRAIN_ALLOWLIST = new Set([
  "/liveness", "/readiness", "/metrics", "/health", "/internal/enter-drain",
]);

function createDrainGateMiddleware() {
  return (req, res, next) => {
    if (currentState === STATES.RUNNING) return next();
    if (DRAIN_ALLOWLIST.has(req.path)) return next();
    onRejectedWork("http");
    logger.debug("Shutdown rejecting HTTP request during drain");
    try {
      res.set("Connection", "close");
      return res.status(503).json({ error: "Server shutting down" });
    } catch {
      return next();
    }
  };
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackAddress(req) {
  const remote = req && req.socket && req.socket.remoteAddress;
  return LOOPBACK_ADDRESSES.has(String(remote || ""));
}

// PreStop trigger: loopback-only, idempotent, DRAINING-only. It cannot run
// phases (it has no handle on the sequence runner by construction).
function createEnterDrainHandler(app = null) {
  return (req, res) => {
    if (!isLoopbackAddress(req)) {
      logger.warn("Shutdown drain trigger rejected (non-loopback source)");
      return res.status(403).json({ error: "Forbidden" });
    }
    const transitioned = enterDraining("prestop", { app });
    return res.status(200).json({ draining: true, transitioned });
  };
}

// New handshakes stop at the Socket.IO layer (Engine.IO owns its own
// listener; Express middleware never sees these requests). Runs BEFORE
// authentication: a drain rejection is not an auth failure.
function drainHandshakeGuard(socket, next) {
  if (currentState !== STATES.RUNNING) {
    onRejectedWork("socket");
    logger.debug("Shutdown rejecting socket handshake during drain");
    return next(new Error("Server shutting down"));
  }
  return next();
}

// Fail-closed packet gate: EVERY client packet is refused while draining
// (ack-carrying packets get an ack error, the rest an error emit — never a
// silent drop). Transport events such as disconnect are not packets and are
// unaffected here; their room work meets the roomTask backstop instead.
function drainPacketGuard(socket, packet, next) {
  if (currentState === STATES.RUNNING) return next();
  onRejectedWork("socket");
  logger.debug("Shutdown rejecting socket packet during drain");
  try {
    const args = Array.isArray(packet) ? packet : [];
    const maybeAck = args.length > 1 ? args[args.length - 1] : null;
    if (typeof maybeAck === "function") {
      maybeAck({ error: "Server shutting down" });
      return;
    }
    socket.emit("error", { message: "Server shutting down" });
  } catch { /* the socket is already gone */ }
}

// --- Phases (each receives an already-clamped budget) -----------------------
async function phaseSettle(budgetMs) {
  if (budgetMs > 0) await new Promise(resolve => setTimeout(resolve, budgetMs));
  return "completed";
}

async function phaseHttp({ server, getInflight, budgetMs }) {
  closeIdle(server);
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (;;) {
    let inflight = 0;
    try {
      inflight = getInflight();
    } catch {
      inflight = 0;
    }
    if (!(inflight > 0)) break;
    const remaining = deadline - Date.now();
    if (!(remaining > 0)) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(HTTP_POLL_MS, remaining)));
  }
  closeIdle(server);
  let left = 0;
  try {
    left = getInflight();
  } catch {
    left = 0;
  }
  if (left > 0) {
    logger.warn("Shutdown HTTP drain timed out (in-flight requests abandoned)", { abandoned: left });
    return "timeout";
  }
  return "completed";
}

async function phaseRoom({ drainRooms, budgetMs }) {
  const cap = Math.max(0, budgetMs);
  const ABANDONED = { total: 0, drained: 0, timedOut: true };
  try {
    // Outer race as well as the callee's own cap: a future drain
    // regression must wedge the phase, never the sequence.
    const result = await withValueDeadline(drainRooms(cap), cap, ABANDONED);
    if (result && result.timedOut) {
      logger.warn("Shutdown room drain timed out (chains abandoned, transactions keep their own guarantees)", {
        total: result.total || 0,
        drained: result.drained || 0,
      });
      return "timeout";
    }
    return "completed";
  } catch (error) {
    logger.error("Shutdown room drain failed", { error: errorText(error) });
    return "timeout";
  }
}

async function phaseSocket({ server, io, budgetMs, raceMs, settleMs }) {
  closeIdle(server);
  const sweep = startIdleSweep(server);
  try {
    const gate = closeIoOnce(io);
    const raced = await withDeadline(gate, Math.min(raceMs, Math.max(0, budgetMs)));
    if (raced) return "completed";
    closeAll(server);
    logger.warn("Shutdown socket close forced (deadline expired, straggler connections destroyed)");
    const rest = Math.max(0, Math.max(0, budgetMs) - Math.min(raceMs, Math.max(0, budgetMs)));
    await withDeadline(gate, Math.min(settleMs, rest));
    return "forced";
  } finally {
    stopIdleSweep(sweep);
  }
}

async function phaseCache({ closeCache, budgetMs }) {
  const FORCED = { closedClean: false };
  let result = FORCED;
  try {
    result = await withValueDeadline(closeCache(), Math.max(0, budgetMs), FORCED);
  } catch (error) {
    logger.error("Shutdown coordination-client close failed", { error: errorText(error) });
    result = FORCED;
  }
  if (result && result.closedClean) return "completed";
  logger.warn("Shutdown coordination-client close forced (continuing to pool close)");
  return "forced";
}

async function phasePg({ closePool, budgetMs }) {
  if (poolEnded) {
    logger.warn("Shutdown pool close skipped (already ended)");
    return "forced";
  }
  poolEnded = true;
  let done = false;
  try {
    done = await withDeadline(closePool(), Math.max(0, budgetMs));
  } catch (error) {
    logger.error("Shutdown pool close failed", { error: errorText(error) });
    done = false;
  }
  if (done) return "completed";
  logger.warn("Shutdown pool close capped (deadline expired, continuing to exit)");
  return "forced";
}

async function runPhase(name, fn) {
  const started = Date.now();
  logger.info("Shutdown phase started", { phase: name });
  let result = "completed";
  try {
    result = await fn();
  } catch (error) {
    logger.error("Shutdown phase failed", { phase: name, error: errorText(error) });
    result = (name === "http" || name === "room") ? "timeout" : "forced";
  }
  onPhase(name, result);
  logger.info("Shutdown phase finished", { phase: name, result, durationMs: Date.now() - started });
  return result;
}

// --- Sequence runner (compare-and-swap: exactly one execution) --------------
const REQUIRED_DEPS = ["server", "io", "getInflight", "drainRooms", "closeCache", "closePool"];

async function runShutdownSequence(deps) {
  if (sequencePromise) {
    logger.debug("Shutdown duplicate sequence request ignored");
    return sequencePromise;
  }
  const missing = REQUIRED_DEPS.filter(key => !deps || deps[key] == null);
  if (missing.length > 0) throw new Error(`shutdown deps missing: ${missing.join(",")}`);
  const {
    app = null, server, io, getInflight, drainRooms, closeCache, closePool,
    exit = code => process.exit(code), exitCode = 0, reason = "SIGTERM", budgets = {},
  } = deps;
  const caps = {
    global: GLOBAL_BUDGET_MS,
    settle: SETTLE_MS,
    http: HTTP_MS,
    room: ROOM_MS,
    socket: SOCKET_MS,
    socketRace: SOCKET_RACE_MS,
    socketSettle: SOCKET_SETTLE_MS,
    cache: CACHE_MS,
    pg: PG_MS,
    ...budgets,
  };
  // DRAINING first (preStop usually did this; SIGTERM converges alone when
  // the trigger was skipped or failed), then STOPPING for the phase run.
  enterDraining(String(reason || "SIGTERM").toLowerCase(), { app });
  if (app && app.locals) app.locals.startupReady = false;
  setState(STATES.STOPPING);
  const info = getShutdownInfo();
  if (!info.prestopSeen) logger.warn("Shutdown sequence started without a preStop drain trigger (converging via signal)");
  logger.info("Shutdown sequence started", { reason: String(reason).slice(0, 32) });

  const startedAt = Date.now();
  const remaining = () => Math.max(0, startedAt + caps.global - Date.now());
  let watchdog = null;
  let watchdogFired = false;

  sequencePromise = (async () => {
    let code = exitCode;
    watchdog = setTimeout(() => {
      watchdogFired = true;
      logger.error("Shutdown global deadline exceeded", { budgetMs: caps.global });
      try {
        exit(1);
      } catch { /* exiting */ }
    }, Math.max(1, caps.global));
    try {
      await runPhase("settle", () => phaseSettle(Math.min(caps.settle, remaining())));
      await runPhase("http", () => phaseHttp({ server, getInflight, budgetMs: Math.min(caps.http, remaining()) }));
      await runPhase("room", () => phaseRoom({ drainRooms, budgetMs: Math.min(caps.room, remaining()) }));
      await runPhase("socket", () => phaseSocket({
        server, io, budgetMs: Math.min(caps.socket, remaining()),
        raceMs: caps.socketRace, settleMs: caps.socketSettle,
      }));
      await runPhase("cache", () => phaseCache({ closeCache, budgetMs: Math.min(caps.cache, remaining()) }));
      await runPhase("pg", () => phasePg({ closePool, budgetMs: Math.min(caps.pg, remaining()) }));
    } catch (error) {
      logger.error("Shutdown sequence failed", { error: errorText(error) });
      code = 1;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    }
    if (watchdogFired) return 1;
    setState(STATES.STOPPED);
    logger.info("Shutdown complete", { exitCode: code });
    try {
      exit(code);
    } catch { /* exiting */ }
    return code;
  })();
  return sequencePromise;
}

// --- Signal wiring (process.on: duplicates are ignored + counted) -----------
// A second signal must not re-enter the sequence; the global watchdog and
// the Kubernetes SIGKILL margin remain the escape hatches for a stuck drain.
function installShutdownHandlers(application, options = {}) {
  const {
    exit = code => process.exit(code), budgets = {},
    getInflight, drainRooms, closeCache, closePool,
  } = options;
  const deps = {
    app: application.app,
    server: application.server,
    io: application.io,
    getInflight, drainRooms, closeCache, closePool,
    exit, budgets,
  };
  const shutdown = (reason, error = null, exitCode = 0) => {
    if (isSequenceStarted()) {
      logger.debug("Shutdown duplicate request ignored", { reason: String(reason).slice(0, 32) });
      return sequencePromise;
    }
    if (error) logger.error(`Shutdown started: ${reason}`, { error: errorText(error) });
    return runShutdownSequence({ ...deps, reason, exitCode });
  };
  const onSigterm = () => {
    if (isSequenceStarted()) {
      onSignal("SIGTERM", "ignored");
      logger.info("Shutdown duplicate signal ignored", { signal: "SIGTERM" });
      return sequencePromise;
    }
    onSignal("SIGTERM", "accepted");
    return shutdown("SIGTERM", null, 0);
  };
  const onSigint = () => {
    if (isSequenceStarted()) {
      onSignal("SIGINT", "ignored");
      logger.info("Shutdown duplicate signal ignored", { signal: "SIGINT" });
      return sequencePromise;
    }
    onSignal("SIGINT", "accepted");
    return shutdown("SIGINT", null, 0);
  };
  const onUncaught = error => shutdown("uncaughtException", error, 1);
  const onRejection = error => shutdown("unhandledRejection", error instanceof Error ? error : new Error(String(error)), 1);
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  const uninstall = () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
  return { shutdown, uninstall };
}

module.exports = {
  STATES, STATE_NAMES,
  PRESTOP_MS, GLOBAL_BUDGET_MS, SETTLE_MS, HTTP_MS, ROOM_MS,
  SOCKET_MS, SOCKET_RACE_MS, SOCKET_SETTLE_MS, CACHE_MS, PG_MS,
  IDLE_SWEEP_MS, HTTP_POLL_MS,
  ShutdownDrainError, isShutdownDrainError,
  getShutdownState, getShutdownStateName, getShutdownInfo,
  isDraining, isSequenceStarted, enterDraining, resetShutdownForTests,
  isLoopbackAddress, createEnterDrainHandler, createDrainGateMiddleware,
  drainHandshakeGuard, drainPacketGuard,
  runShutdownSequence, installShutdownHandlers,
};
