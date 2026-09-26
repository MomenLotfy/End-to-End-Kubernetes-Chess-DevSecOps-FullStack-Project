process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";
process.env.FRONTEND_URL = "http://localhost:3000";

// Wave 7 Phase 6: deterministic shutdown/drain suite. Every test uses
// injected fakes and short budgets with real timers — outcomes never depend
// on tight races, and no test needs live Redis, PostgreSQL, or Kubernetes.
const fs = require("fs");
const path = require("path");
const request = require("supertest");

const shutdown = require("../src/services/shutdown");
const {
  shutdownState, shutdownRejected, shutdownPhases, shutdownSignals,
  roomOperationFailures, registry,
} = require("../src/metrics/index");
const { EXCLUDED_PATHS } = require("../src/metrics/http");
const gameSocket = require("../src/socket/gameSocket");

const FAST = {
  global: 2000, settle: 5, http: 60, room: 60,
  socket: 200, socketRace: 120, socketSettle: 30, cache: 60, pg: 60,
};

function exposition() {
  return registry.exposition();
}

function resetShutdownMetrics() {
  for (const metric of [shutdownState, shutdownRejected, shutdownPhases, shutdownSignals, roomOperationFailures]) {
    metric.resetForTests();
  }
}

beforeEach(() => {
  shutdown.resetShutdownForTests();
  resetShutdownMetrics();
  gameSocket.activeRooms.clear();
});

afterEach(() => {
  shutdown.resetShutdownForTests();
  resetShutdownMetrics();
  gameSocket.activeRooms.clear();
  jest.restoreAllMocks();
});

function makeServer() {
  return {
    closeIdleConnections: jest.fn(),
    closeAllConnections: jest.fn(),
    close: jest.fn(() => { throw new Error("server.close must never be called by shutdown code"); }),
  };
}

function makeIo() {
  return { close: jest.fn(callback => { if (typeof callback === "function") callback(); }) };
}

function makeDeps(overrides = {}) {
  return {
    app: { locals: { startupReady: true, shuttingDown: false } },
    server: makeServer(),
    io: makeIo(),
    getInflight: () => 0,
    drainRooms: async () => ({ total: 0, drained: 0, timedOut: false }),
    closeCache: async () => ({ closedClean: true }),
    closePool: jest.fn(async () => {}),
    exit: jest.fn(),
    budgets: { ...FAST },
    ...overrides,
  };
}

// --- A. state machine -------------------------------------------------------
test("starts RUNNING; enterDraining transitions exactly once", () => {
  expect(shutdown.getShutdownState()).toBe(shutdown.STATES.RUNNING);
  expect(shutdown.enterDraining("prestop")).toBe(true);
  expect(shutdown.getShutdownState()).toBe(shutdown.STATES.DRAINING);
  expect(shutdown.enterDraining("prestop")).toBe(false);
  expect(shutdown.getShutdownInfo().prestopSeen).toBe(true);
});

test("enterDraining flips app.locals.shuttingDown for readiness", () => {
  const app = { locals: { startupReady: true, shuttingDown: false } };
  shutdown.enterDraining("prestop", { app });
  expect(app.locals.shuttingDown).toBe(true);
  expect(app.locals.startupReady).toBe(true); // startup flag untouched by the trigger
});

test("sequence walks DRAINING -> STOPPING -> STOPPED", async () => {
  const seen = [];
  const deps = makeDeps({
    drainRooms: async () => {
      seen.push(shutdown.getShutdownStateName());
      return { total: 0, drained: 0, timedOut: false };
    },
  });
  expect(shutdown.getShutdownStateName()).toBe("RUNNING");
  const code = await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(code).toBe(0);
  expect(seen).toEqual(["STOPPING"]);
  expect(shutdown.getShutdownStateName()).toBe("STOPPED");
  expect(deps.app.locals).toMatchObject({ startupReady: false, shuttingDown: true });
});

test("reset restores RUNNING and re-arms the pool guard", async () => {
  const deps = makeDeps();
  await shutdown.runShutdownSequence(deps);
  expect(deps.closePool).toHaveBeenCalledTimes(1);
  shutdown.resetShutdownForTests();
  expect(shutdown.getShutdownStateName()).toBe("RUNNING");
  expect(shutdown.getShutdownInfo().poolEnded).toBe(false);
});

// --- B. preStop endpoint ----------------------------------------------------
function fakeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test("loopback trigger enters DRAINING with an idempotent 200", () => {
  const app = { locals: { startupReady: true, shuttingDown: false } };
  const handler = shutdown.createEnterDrainHandler(app);
  const first = fakeRes();
  handler({ socket: { remoteAddress: "127.0.0.1" } }, first);
  expect(first.statusCode).toBe(200);
  expect(first.body).toEqual({ draining: true, transitioned: true });
  expect(shutdown.getShutdownStateName()).toBe("DRAINING");
  const second = fakeRes();
  handler({ socket: { remoteAddress: "::1" } }, second);
  expect(second.statusCode).toBe(200);
  expect(second.body).toEqual({ draining: true, transitioned: false });
});

test("non-loopback trigger is rejected and changes nothing", () => {
  const handler = shutdown.createEnterDrainHandler();
  for (const remoteAddress of ["10.0.1.23", "192.168.1.5", null, undefined]) {
    const res = fakeRes();
    handler({ socket: { remoteAddress } }, res);
    expect(res.statusCode).toBe(403);
  }
  expect(shutdown.getShutdownStateName()).toBe("RUNNING");
  expect(shutdown.isSequenceStarted()).toBe(false);
});

test("trigger never executes the sequence (SIGTERM converges alone)", async () => {
  shutdown.enterDraining("prestop");
  expect(shutdown.isSequenceStarted()).toBe(false);
  const deps = makeDeps();
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(deps.exit).toHaveBeenCalledWith(0);
  expect(shutdown.getShutdownInfo().prestopSeen).toBe(true);
});

test("trigger path is excluded from HTTP access metrics", () => {
  expect(EXCLUDED_PATHS.has("/internal/enter-drain")).toBe(true);
});

test("SIGTERM without any preStop trigger still converges (prestopSeen=false)", async () => {
  const deps = makeDeps();
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(deps.exit).toHaveBeenCalledWith(0);
  expect(shutdown.getShutdownInfo().prestopSeen).toBe(false);
  expect(shutdown.getShutdownStateName()).toBe("STOPPED");
});

// --- C. HTTP gate -----------------------------------------------------------
test("gate passes everything through while RUNNING", () => {
  const gate = shutdown.createDrainGateMiddleware();
  const next = jest.fn();
  gate({ path: "/api/game/active", method: "GET" }, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
});

test("gate 503s application work while DRAINING and counts it", () => {
  shutdown.enterDraining("prestop");
  const gate = shutdown.createDrainGateMiddleware();
  const headers = {};
  const res = fakeRes();
  res.set = (key, value) => { headers[key] = value; };
  const next = jest.fn();
  gate({ path: "/api/auth/login", method: "POST" }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(503);
  expect(res.body).toEqual({ error: "Server shutting down" });
  expect(headers.Connection).toBe("close");
  expect(exposition()).toContain('shutdown_rejected_total{source="http"} 1');
});

test("gate allowlists probes, metrics, health, and the trigger", () => {
  shutdown.enterDraining("prestop");
  const gate = shutdown.createDrainGateMiddleware();
  for (const url of ["/liveness", "/readiness", "/metrics", "/health", "/internal/enter-drain"]) {
    const next = jest.fn();
    gate({ path: url, method: "GET" }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  }
});

// --- D. socket guards -------------------------------------------------------
test("handshake guard passes RUNNING, rejects draining (not an auth failure)", () => {
  const next = jest.fn();
  shutdown.drainHandshakeGuard({}, next);
  expect(next).toHaveBeenCalledWith();
  shutdown.enterDraining("prestop");
  const drainNext = jest.fn();
  shutdown.drainHandshakeGuard({}, drainNext);
  expect(drainNext).toHaveBeenCalledTimes(1);
  expect(drainNext.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(exposition()).toContain('shutdown_rejected_total{source="socket"} 1');
});

test("packet guard passes RUNNING packets untouched", () => {
  const socket = { emit: jest.fn() };
  const next = jest.fn();
  shutdown.drainPacketGuard(socket, ["make_move", {}], next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(socket.emit).not.toHaveBeenCalled();
});

test("packet guard refuses plain packets with an error emit (no silent drop)", () => {
  shutdown.enterDraining("prestop");
  const socket = { emit: jest.fn() };
  const next = jest.fn();
  shutdown.drainPacketGuard(socket, ["make_move", { roomId: "X" }], next);
  expect(next).not.toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith("error", { message: "Server shutting down" });
  expect(exposition()).toContain('shutdown_rejected_total{source="socket"} 1');
});

test("packet guard answers ack-carrying packets via the ack (leave_room shape)", () => {
  shutdown.enterDraining("prestop");
  const socket = { emit: jest.fn() };
  const ack = jest.fn();
  const next = jest.fn();
  shutdown.drainPacketGuard(socket, ["leave_room", { roomId: "X" }, ack], next);
  expect(next).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledWith({ error: "Server shutting down" });
  expect(socket.emit).not.toHaveBeenCalled();
});

// --- E. room gate + bounded drain -------------------------------------------
test("roomTask runs and chains while RUNNING", async () => {
  const room = { id: "ABC1234", operation: Promise.resolve() };
  const order = [];
  const before = room.operation;
  await gameSocket.roomTask(room, async () => { order.push("task"); });
  expect(order).toEqual(["task"]);
  expect(room.operation).not.toBe(before);
});

test("roomTask rejects while DRAINING without running the task", async () => {
  shutdown.enterDraining("prestop");
  const room = { id: "ABC1234", operation: Promise.resolve() };
  const task = jest.fn(async () => {});
  await expect(gameSocket.roomTask(room, task)).rejects.toMatchObject({
    name: "ShutdownDrainError",
    code: "SHUTDOWN_DRAINING",
  });
  expect(task).not.toHaveBeenCalled();
  expect(exposition()).toContain('shutdown_rejected_total{source="room"} 1');
});

test("rejected room op preserves the chain and emits no failure metric", async () => {
  shutdown.enterDraining("prestop");
  const room = { id: "ABC1234", operation: Promise.resolve("tail") };
  const before = room.operation;
  await expect(gameSocket.roomTask(room, async () => {})).rejects.toBeInstanceOf(shutdown.ShutdownDrainError);
  expect(room.operation).toBe(before);
  expect(await room.operation).toBe("tail");
  expect(exposition()).not.toMatch(/^room_operation_failures_total \d+/m);
  expect(shutdown.isShutdownDrainError(new shutdown.ShutdownDrainError())).toBe(true);
  expect(shutdown.isShutdownDrainError(new Error("nope"))).toBe(false);
});

test("bounded drain completes when tails settle", async () => {
  let release = null;
  const tail = new Promise(resolve => { release = resolve; });
  gameSocket.activeRooms.set("DRAIN01", { id: "DRAIN01", operation: tail });
  const pending = gameSocket.drainRoomOperations(500);
  release();
  const result = await pending;
  expect(result).toEqual({ total: 1, drained: 1, timedOut: false });
});

test("bounded drain times out on a hanging tail and still returns", async () => {
  gameSocket.activeRooms.set("HANG001", { id: "HANG001", operation: new Promise(() => {}) });
  const started = Date.now();
  const result = await gameSocket.drainRoomOperations(40);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result).toEqual({ total: 1, drained: 0, timedOut: true });
});

test("bounded drain of zero rooms completes immediately", async () => {
  await expect(gameSocket.drainRoomOperations(40)).resolves.toEqual({ total: 0, drained: 0, timedOut: false });
});

// --- F. ordering + HTTP/Socket.IO coupling ----------------------------------
test("phases run in the exact approved order", async () => {
  const order = [];
  const deps = makeDeps({
    getInflight: () => { order.push("http-poll"); return 0; },
    drainRooms: async budgetMs => { order.push(`room:${budgetMs}`); return { total: 0, drained: 0, timedOut: false }; },
    closeCache: async () => { order.push("cache"); return { closedClean: true }; },
    closePool: jest.fn(async () => { order.push("pg"); }),
  });
  deps.io.close = jest.fn(() => { order.push("socket"); return Promise.resolve(); });
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  const phases = [...new Set(order.map(entry => String(entry).split(":")[0].replace("http-poll", "http")))];
  expect(phases).toEqual(["http", "room", "socket", "cache", "pg"]);
  expect(order.filter(entry => entry === "socket")).toHaveLength(1);
});

test("io.close is the sole closer: called once, server close never invoked", async () => {
  const deps = makeDeps();
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(deps.io.close).toHaveBeenCalledTimes(1);
  expect(deps.server.close).not.toHaveBeenCalled();
  expect(deps.server.closeIdleConnections.mock.calls.length).toBeGreaterThanOrEqual(1);
});

test("idle sweep runs while io.close is pending (no hang, completed)", async () => {
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  const deps = makeDeps({
    budgets: { ...FAST, socket: 600, socketRace: 500, socketSettle: 50 },
  });
  deps.io.close = jest.fn(() => {
    setTimeout(() => release(), 250);
    return gate;
  });
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(deps.io.close).toHaveBeenCalledTimes(1);
  // One pre-close call plus at least one sweep tick inside 250ms.
  expect(deps.server.closeIdleConnections.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(deps.server.closeAllConnections).not.toHaveBeenCalled();
  expect(exposition()).toContain('shutdown_phase_total{phase="socket",result="completed"} 1');
  expect(deps.exit).toHaveBeenCalledWith(0);
});

test("pending io.close past the race deadline forces closeAll once and proceeds", async () => {
  const order = [];
  const deps = makeDeps({
    budgets: { ...FAST, socket: 120, socketRace: 40, socketSettle: 20 },
    closePool: jest.fn(async () => { order.push("pg"); }),
  });
  deps.io.close = jest.fn(() => new Promise(() => {})); // hangs forever
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(deps.io.close).toHaveBeenCalledTimes(1);
  expect(deps.server.closeAllConnections).toHaveBeenCalledTimes(1);
  expect(exposition()).toContain('shutdown_phase_total{phase="socket",result="forced"} 1');
  expect(order).toEqual(["pg"]); // later phases still ran
  expect(deps.exit).toHaveBeenCalledWith(0);
  expect(shutdown.getShutdownStateName()).toBe("STOPPED");
});

test("shutdown source pins the coupling contract (one io close site, no direct close)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "shutdown.js"), "utf8");
  expect(source.match(/io\.close\(/g) || []).toHaveLength(1);
  expect(source).not.toContain("server.close(");
  expect(source).not.toContain("ERR_SERVER_NOT_RUNNING");
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  expect(serverSource).not.toContain("server.close(");
});

test("unclean cache close marks forced and still exits 0", async () => {
  const deps = makeDeps({ closeCache: async () => ({ closedClean: false }) });
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(exposition()).toContain('shutdown_phase_total{phase="cache",result="forced"} 1');
  expect(deps.exit).toHaveBeenCalledWith(0);
});

test("hanging pool end is capped, called once, and still exits 0", async () => {
  const closePool = jest.fn(() => new Promise(() => {}));
  const deps = makeDeps({ closePool, budgets: { ...FAST, pg: 40 } });
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(closePool).toHaveBeenCalledTimes(1);
  expect(exposition()).toContain('shutdown_phase_total{phase="pg",result="forced"} 1');
  expect(deps.exit).toHaveBeenCalledWith(0);
  expect(shutdown.getShutdownStateName()).toBe("STOPPED");
});

test("stuck HTTP work times out the phase without blocking later phases", async () => {
  const order = [];
  const deps = makeDeps({
    getInflight: () => 3,
    budgets: { ...FAST, http: 40 },
    closePool: jest.fn(async () => { order.push("pg"); }),
  });
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(exposition()).toContain('shutdown_phase_total{phase="http",result="timeout"} 1');
  expect(order).toEqual(["pg"]);
  expect(deps.exit).toHaveBeenCalledWith(0);
});

test("room timeout is reported and the sequence continues", async () => {
  const deps = makeDeps({
    drainRooms: async () => ({ total: 2, drained: 1, timedOut: true }),
  });
  await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(exposition()).toContain('shutdown_phase_total{phase="room",result="timeout"} 1');
  expect(deps.exit).toHaveBeenCalledWith(0);
});

// --- G. global deadline, exits, duplicates ----------------------------------
test("global watchdog is armed with the cap and cleared on completion", async () => {
  // Every phase is clamped to remaining, so completion always wins the race
  // against the watchdog in every constructible case — the watchdog is a
  // last-resort backstop whose fire outcome cannot be simulated without a
  // test-only seam (deliberately not added). What IS pinned: it is armed
  // with exactly the global cap, it never fires on a clean run, and its
  // timer is cleared (no leaked exit(1) after a clean shutdown).
  const setSpy = jest.spyOn(global, "setTimeout");
  const clearSpy = jest.spyOn(global, "clearTimeout");
  const deps = makeDeps({ budgets: { ...FAST, global: 1500 } });
  const code = await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(code).toBe(0);
  const armedAt = setSpy.mock.calls.findIndex(call => call[1] === 1500);
  expect(armedAt).toBeGreaterThanOrEqual(0);
  const watchdogTimer = setSpy.mock.results[armedAt].value;
  expect(clearSpy.mock.calls.some(call => call[0] === watchdogTimer)).toBe(true);
  expect(deps.exit).toHaveBeenCalledTimes(1);
  expect(deps.exit).toHaveBeenCalledWith(0);
});

test("clean run exits 0 at STOPPED with the state gauge at 3", async () => {
  const deps = makeDeps();
  const code = await shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  expect(code).toBe(0);
  expect(deps.exit).toHaveBeenCalledWith(0);
  expect(exposition()).toContain("shutdown_state 3");
  for (const phase of ["settle", "http", "room", "socket", "cache", "pg"]) {
    expect(exposition()).toContain(`shutdown_phase_total{phase="${phase}",result="completed"} 1`);
  }
});

test("crash path exits 1 after the bounded sequence", async () => {
  const deps = makeDeps();
  const code = await shutdown.runShutdownSequence({ ...deps, reason: "uncaughtException", exitCode: 1 });
  expect(code).toBe(1);
  expect(deps.exit).toHaveBeenCalledWith(1);
  expect(shutdown.getShutdownStateName()).toBe("STOPPED");
});

test("concurrent duplicate sequences execute phases exactly once", async () => {
  const deps = makeDeps();
  const first = shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  const second = shutdown.runShutdownSequence({ ...deps, reason: "SIGTERM" });
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(0);
  expect(b).toBe(0);
  expect(deps.io.close).toHaveBeenCalledTimes(1);
  expect(deps.closePool).toHaveBeenCalledTimes(1);
  expect(deps.exit).toHaveBeenCalledTimes(1);
});

test("duplicate SIGTERM is ignored, counted, and exits once", async () => {
  const application = {
    app: { locals: { startupReady: true, shuttingDown: false } },
    server: makeServer(),
    io: makeIo(),
  };
  const exit = jest.fn();
  const handlers = shutdown.installShutdownHandlers(application, {
    exit,
    budgets: { ...FAST },
    getInflight: () => 0,
    drainRooms: async () => ({ total: 0, drained: 0, timedOut: false }),
    closeCache: async () => ({ closedClean: true }),
    closePool: async () => {},
  });
  try {
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await handlers.shutdown("test-drain");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exposition()).toContain('shutdown_signals_total{signal="SIGTERM",action="accepted"} 1');
    expect(exposition()).toContain('shutdown_signals_total{signal="SIGTERM",action="ignored"} 1');
  } finally {
    handlers.uninstall();
  }
});

// --- H. application wiring --------------------------------------------------
test("enter-drain wiring: readiness false, liveness independent, routes gated", async () => {
  const { createApplication } = require("../src/server");
  const { app, io } = createApplication();
  try {
    expect((await request(app).get("/readiness")).status).toBe(503); // startup not done
    const trigger = await request(app).get("/internal/enter-drain");
    expect(trigger.status).toBe(200);
    expect(trigger.body).toEqual({ draining: true, transitioned: true });
    expect((await request(app).get("/readiness")).status).toBe(503);
    expect((await request(app).get("/liveness")).status).toBe(200);
    const gated = await request(app).post("/api/auth/login").send({});
    expect(gated.status).toBe(503);
    expect(gated.body).toEqual({ error: "Server shutting down" });
  } finally {
    await new Promise(resolve => io.close(resolve));
  }
});

test("server installShutdownHandlers runs the full sequence and exits 0", async () => {
  const { createApplication, installShutdownHandlers } = require("../src/server");
  const { pool } = require("../src/config/db");
  const application = createApplication();
  const poolEnd = jest.spyOn(pool, "end").mockResolvedValue();
  const exit = jest.fn();
  const handlers = installShutdownHandlers(application, { exit, budgets: { ...FAST } });
  try {
    await handlers.shutdown("test");
    expect(exit).toHaveBeenCalledWith(0);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(application.app.locals).toMatchObject({ startupReady: false, shuttingDown: true });
  } finally {
    poolEnd.mockRestore();
    handlers.uninstall();
  }
});
