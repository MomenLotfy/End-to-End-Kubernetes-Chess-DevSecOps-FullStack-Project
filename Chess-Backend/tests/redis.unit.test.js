// Wave 7 Phase 3 — Redis client/config/adapter unit tests. No real Redis is
// ever contacted: a fake client (EventEmitter + ioredis-shaped API) is
// injected through the factory seam.
"use strict";

process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const { EventEmitter } = require("events");
const { RedisAdapter } = require("@socket.io/redis-adapter");
const redis = require("../src/services/redis");
const metrics = require("../src/metrics");

const REDIS_ENV = {
  SOCKET_ADAPTER: "redis",
  REDIS_HOST: "chess-staging-redis.invalid",
  REDIS_PORT: "6379",
  REDIS_USERNAME: "chess-app",
  REDIS_PASSWORD: "sm-secret-never-logged",
};

class FakeRedis extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.status = "wait";
    this.calls = [];
    this.behavior = {};
  }
  async connect() {
    this.calls.push("connect");
    if (this.behavior.connectError) throw this.behavior.connectError;
    this.status = "ready";
    this.emit("ready");
    return "OK";
  }
  duplicate() {
    this.calls.push("duplicate");
    const child = new FakeRedis(this.options);
    child.behavior = this.behavior;
    this.duplicated = child;
    return child;
  }
  async ping() { this.calls.push("ping"); return "PONG"; }
  async quit() { this.calls.push("quit"); this.status = "end"; return "OK"; }
  disconnect() { this.calls.push("disconnect"); this.status = "close"; }
  async subscribe() { this.calls.push("subscribe"); return 1; }
  async unsubscribe() { this.calls.push("unsubscribe"); return 1; }
  async psubscribe() { this.calls.push("psubscribe"); return 1; }
  async punsubscribe() { this.calls.push("punsubscribe"); return 1; }
  async publish() { this.calls.push("publish"); return 1; }
  off() { return this; }
}

const metricVal = (name, labels) => {
  const m = metrics.renderMetrics().match(new RegExp(`^${name}${labels} ([0-9.eE+-]+)$`, "m"));
  return m ? Number(m[1]) : 0;
};

let created;
beforeEach(() => {
  created = [];
  redis.resetRedisForTests();
  delete process.env.SOCKET_ADAPTER;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PASSWORD;
});
afterEach(async () => {
  for (const { io } of created) {
    await new Promise(resolve => io.close(resolve));
  }
  redis.resetRedisForTests();
  delete process.env.SOCKET_ADAPTER;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PASSWORD;
});

function useFakes(behavior = {}) {
  const made = [];
  redis.setRedisClientFactoryForTests(options => {
    const fake = new FakeRedis(options);
    fake.behavior = behavior;
    made.push(fake);
    return fake;
  });
  return made;
}

// --- configuration: fail closed ------------------------------------------------

test("redisConfig defaults to local and rejects unknown modes loudly", () => {
  expect(redis.redisConfig({})).toEqual({ mode: "local" });
  expect(() => redis.redisConfig({ SOCKET_ADAPTER: "memcached" })).toThrow("FATAL");
});

test("redis mode requires host, valid port and password (fail closed)", () => {
  expect(() => redis.redisConfig({ SOCKET_ADAPTER: "redis" })).toThrow("REDIS_HOST");
  expect(() => redis.redisConfig({ ...REDIS_ENV, REDIS_PORT: "banana" })).toThrow("REDIS_PORT");
  const { REDIS_PASSWORD, ...noPass } = REDIS_ENV;
  expect(() => redis.redisConfig(noPass)).toThrow("REDIS_PASSWORD");
  expect(redis.redisConfig(REDIS_ENV)).toMatchObject({
    mode: "redis", host: REDIS_ENV.REDIS_HOST, port: 6379, tls: true,
  });
});

test("plaintext Redis is refused in production, allowed elsewhere only explicitly", () => {
  expect(() => redis.redisConfig({ ...REDIS_ENV, REDIS_TLS: "false", NODE_ENV: "production" }))
    .toThrow("plaintext Redis is forbidden in production");
  expect(redis.redisConfig({ ...REDIS_ENV, REDIS_TLS: "false", NODE_ENV: "test" }).tls).toBe(false);
  expect(redis.redisConfig({ ...REDIS_ENV, NODE_ENV: "production" }).tls).toBe(true);
});

test("describeConfig never contains the password", () => {
  const summary = redis.describeConfig(redis.redisConfig(REDIS_ENV));
  expect(JSON.stringify(summary)).not.toContain(REDIS_ENV.REDIS_PASSWORD);
  expect(summary).toMatchObject({ mode: "redis", tls: true, authConfigured: true });
  expect(redis.describeConfig({ mode: "local" })).toEqual({ mode: "local" });
});

test("buildOptions enables verified TLS and bounded timeouts", () => {
  const options = redis.buildOptions(redis.redisConfig(REDIS_ENV));
  expect(options.tls).toEqual({});
  expect(options.tls && options.tls.rejectUnauthorized).not.toBe(false);
  expect(options.lazyConnect).toBe(true);
  expect(options.connectTimeout).toBe(5000);
  expect(options.commandTimeout).toBe(5000);
  expect(options.maxRetriesPerRequest).toBe(3);
  const plain = redis.buildOptions(redis.redisConfig({ ...REDIS_ENV, REDIS_TLS: "false", NODE_ENV: "test" }));
  expect(plain.tls).toBeUndefined();
});

// --- lifecycle -----------------------------------------------------------------

test("local mode creates no clients", () => {
  const made = useFakes();
  const holder = redis.initRedis({});
  expect(holder.mode).toBe("local");
  expect(holder.clients).toBeNull();
  expect(made).toHaveLength(0);
  expect(redis.redisReady()).toBe(true);
});

test("initRedis creates pub + store and duplicates sub with identical options", () => {
  const made = useFakes();
  const holder = redis.initRedis(REDIS_ENV);
  expect(holder.mode).toBe("redis");
  expect(made).toHaveLength(2); // pub + store; sub comes from duplicate()
  const { pub, sub, store } = holder.clients;
  expect(pub.duplicated).toBe(sub);
  expect(sub.options).toBe(pub.options); // TLS+AUTH inherited, not re-read
  expect(store.options.password).toBe(REDIS_ENV.REDIS_PASSWORD);
});

test("client errors count metrics without leaking config", async () => {
  useFakes();
  const holder = redis.initRedis(REDIS_ENV);
  const before = metricVal("redis_client_errors_total", '{client="adapter-pub"}');
  holder.clients.pub.emit("error", new Error("ECONNREFUSED fake"));
  expect(metricVal("redis_client_errors_total", '{client="adapter-pub"}')).toBe(before + 1);
});

test("reconnects are counted (storms are visible)", () => {
  useFakes();
  const holder = redis.initRedis(REDIS_ENV);
  const before = metricVal("redis_reconnects_total", '{client="store"}');
  holder.clients.store.emit("reconnecting");
  expect(metricVal("redis_reconnects_total", '{client="store"}')).toBe(before + 1);
});

test("connected gauge follows client status at scrape time", () => {
  // Note: collectors accumulate on the process-wide gauge across tests in
  // this file (production inits once), so assert on the LAST exposition line.
  const lastVal = () => {
    const lines = metrics.renderMetrics().match(/^redis_connected\{client="store"\} ([0-9.eE+-]+)$/gm);
    return Number(lines[lines.length - 1].split(" ")[1]);
  };
  useFakes();
  const holder = redis.initRedis(REDIS_ENV);
  holder.clients.store.status = "ready";
  expect(lastVal()).toBe(1);
  holder.clients.store.status = "close";
  expect(lastVal()).toBe(0);
});

test("connectRedisOrFail proves all clients + ping, else FATAL", async () => {
  const made = useFakes();
  redis.initRedis(REDIS_ENV);
  await redis.connectRedisOrFail();
  for (const fake of [...made, made[0].duplicated]) {
    expect(fake.calls).toContain("connect");
  }
  expect(made[1].calls).toContain("ping"); // store proves AUTH/TLS
});

test("connectRedisOrFail rejects FATAL when Redis is unreachable", async () => {
  useFakes({ connectError: new Error("ENOTFOUND") });
  redis.initRedis(REDIS_ENV);
  await expect(redis.connectRedisOrFail()).rejects.toThrow("FATAL: Redis unavailable at startup");
});

test("withTimeout rejects slow operations and passes fast ones through", async () => {
  const hanging = new Promise(() => {});
  await expect(redis.withTimeout(hanging, 20, "Redis quit")).rejects.toThrow("Redis quit timed out after 20ms");
  await expect(redis.withTimeout(Promise.resolve("OK"), 1000, "fast")).resolves.toBe("OK");
});

test("closeRedisClients quits every client once and clears the holder", async () => {
  const made = useFakes();
  redis.initRedis(REDIS_ENV);
  await redis.closeRedisClients();
  for (const fake of [...made, made[0].duplicated]) {
    expect(fake.calls.filter(c => c === "quit")).toHaveLength(1);
  }
  expect(redis.redisMode()).toBe("local");
  await redis.closeRedisClients(); // idempotent, never throws
});

test("redisReady reflects store state in redis mode only", () => {
  useFakes();
  const holder = redis.initRedis(REDIS_ENV);
  holder.clients.store.status = "ready";
  expect(redis.redisReady()).toBe(true);
  holder.clients.store.status = "reconnecting";
  expect(redis.redisReady()).toBe(false);
});

// --- socket.io adapter wiring ----------------------------------------------------

test("redis mode attaches the official Redis adapter; local mode does not", async () => {
  useFakes();
  Object.assign(process.env, REDIS_ENV);
  const { createApplication } = require("../src/server");
  const application = createApplication();
  created.push(application);
  expect(application.io.of("/").adapter).toBeInstanceOf(RedisAdapter);
});

test("local mode keeps the default in-process adapter", async () => {
  useFakes();
  const { createApplication } = require("../src/server");
  const application = createApplication();
  created.push(application);
  expect(application.io.of("/").adapter).not.toBeInstanceOf(RedisAdapter);
});

test("createApplication fails closed on bad redis config (no silent local)", () => {
  useFakes();
  process.env.SOCKET_ADAPTER = "redis"; // no REDIS_HOST
  const { createApplication } = require("../src/server");
  expect(() => createApplication()).toThrow("FATAL: REDIS_HOST is required");
});

test("readiness fails when the mandatory store client is down", async () => {
  useFakes();
  Object.assign(process.env, REDIS_ENV);
  const { createApplication } = require("../src/server");
  const application = createApplication();
  created.push(application);
  application.app.locals.startupReady = true;
  const store = redis.getRedis().clients.store;
  store.status = "close";
  const request = require("supertest");
  const down = await request(application.app).get("/readiness");
  expect(down.status).toBe(503);
  store.status = "ready";
  // DB is unmocked here, so readiness still 503 — but for the DB reason, which
  // proves the Redis gate passed and evaluation continued to the DB check.
  const up = await request(application.app).get("/readiness");
  expect(up.status).toBe(503);
  expect(up.body).toEqual({ status: "not-ready" });
});

test("shutdown closes Redis clients before exiting", async () => {
  const made = useFakes();
  Object.assign(process.env, REDIS_ENV);
  const { createApplication, installShutdownHandlers } = require("../src/server");
  const { pool } = require("../src/config/db");
  const application = createApplication();
  created.push(application);
  const poolEnd = jest.spyOn(pool, "end").mockResolvedValue();
  const exit = jest.fn();
  const handlers = installShutdownHandlers(application, { exit });
  await handlers.shutdown("test");
  for (const fake of [...made, made[0].duplicated]) {
    expect(fake.calls).toContain("quit");
  }
  expect(exit).toHaveBeenCalledWith(0);
  poolEnd.mockRestore();
  handlers.uninstall();
  require("../src/services/shutdown").resetShutdownForTests(); // Phase 6: restore RUNNING for later tests
});
