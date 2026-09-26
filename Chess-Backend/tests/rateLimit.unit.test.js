// Wave 7 Phase 5 — shared rate limiting unit tests. No live Redis is ever
// contacted: a script-emulating fake (synchronous Lua semantics, like the
// server) is injected directly (bare-app tests) or through the Phase 3
// factory seam (createApplication integration).
"use strict";

process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const { EventEmitter } = require("events");
const express = require("express");
const request = require("supertest");
const redis = require("../src/services/redis");
const metrics = require("../src/metrics");
const logger = require("../src/config/logger");
const {
  GLOBAL_LIMITER_SPEC, ROUTE_LIMITER_SPECS, LIMITER_NAMES,
  RATE_LIMIT_REDIS_TIMEOUT_MS, createRateLimiters,
} = require("../src/services/rateLimit");

const REDIS_ENV = {
  SOCKET_ADAPTER: "redis",
  REDIS_HOST: "chess-staging-redis.invalid",
  REDIS_PORT: "6379",
  REDIS_USERNAME: "chess-app",
  REDIS_PASSWORD: "sm-secret-never-logged",
};

// Script-emulating fake for the `store` wire the limiter uses. EVALSHA runs
// the rate-limit-redis increment Lua SYNCHRONOUSLY (no awaits => no
// interleave), mirroring the server-side atomicity the phase relies on; the
// emulation is line-for-line the script verified in rate-limit-redis@4.3.1:
// PTTL<=0 => SET key 1 PX windowMs, else INCR. TEST-NET addresses only.
class FakeLimiterRedis extends EventEmitter {
  constructor() {
    super();
    this.options = {};
    this.status = "wait"; // mirrors lazyConnect: not ready until connected
    this.mode = "ok"; // ok | error | hang
    this.keys = new Map(); // key -> { count, expiresAt }
    this.ttls = []; // { key, windowMs } per fresh key (TTL proof)
    this.calls = [];
  }
  async connect() { this.status = "ready"; this.emit("ready"); return "OK"; }
  duplicate() { return new FakeLimiterRedis(); }
  async ping() { return "PONG"; }
  async quit() { this.status = "end"; return "OK"; }
  disconnect() { this.status = "close"; }
  async subscribe() { return 1; }
  async unsubscribe() { return 1; }
  async psubscribe() { return 1; }
  async punsubscribe() { return 1; }
  async publish() { return 1; }
  expireNow(key) {
    const entry = this.keys.get(key);
    if (entry) entry.expiresAt = 0;
  }
  async call(...args) {
    this.calls.push(args);
    // Adversarial error text: embeds an IP and the raw command. NOTHING of
    // it may reach metrics, logs, or HTTP bodies (sanitization tests below).
    if (this.mode === "error") throw new Error(`ADVERSARIAL 203.0.113.99 EVALSHA ${args.join(" ")}`);
    if (this.mode === "hang") return new Promise(() => {});
    const [command, ...rest] = args;
    if (command === "SCRIPT") return "fakesha1";
    if (command === "EVALSHA") {
      const [, , key, , windowMs] = rest;
      return this.increment(key, Number(windowMs));
    }
    if (command === "DECR") {
      const entry = this.keys.get(rest[0]);
      if (entry) entry.count -= 1;
      return entry ? entry.count : 0;
    }
    if (command === "DEL") return this.keys.delete(rest[0]) ? 1 : 0;
    throw new Error(`unexpected command ${command}`);
  }
  increment(key, windowMs) {
    const now = Date.now();
    const entry = this.keys.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.keys.set(key, { count: 1, expiresAt: now + windowMs });
      this.ttls.push({ key, windowMs });
      return [1, windowMs];
    }
    entry.count += 1;
    return [entry.count, entry.expiresAt - now];
  }
}

const metricVal = (name, labels = "") => {
  const m = metrics.renderMetrics().match(new RegExp(`^${name}${labels} ([0-9.eE+-]+)$`, "m"));
  return m ? Number(m[1]) : 0;
};
const degraded = name => metricVal("rate_limit_degraded_total", `{limiter="${name}"}`);

// express-rate-limit draft-7 emits the COMBINED RateLimit header
// ("limit=5, remaining=0, reset=60") plus RateLimit-Policy (and Retry-After on
// 429) — never the separate Limit/Remaining/Reset fields.
function parseRateLimit(headers) {
  const header = headers.ratelimit || "";
  const pick = field => {
    const m = header.match(new RegExp(`${field}=(\\d+)`));
    return m ? m[1] : undefined;
  };
  return { limit: pick("limit"), remaining: pick("remaining"), reset: pick("reset") };
}

function readyStore() {
  const fake = new FakeLimiterRedis();
  fake.status = "ready";
  return fake;
}

// Bare app: ONE limiter in front of a trivial 200 handler. Trusts one proxy
// hop (production value) so X-Forwarded-For selects the client bucket.
function bareApp(limiter) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(limiter);
  app.use((req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function fire(app, times, { ip, method = "get", path = "/" } = {}) {
  const responses = [];
  for (let i = 0; i < times; i += 1) {
    let req = request(app)[method](path);
    if (ip) req = req.set("X-Forwarded-For", ip);
    responses.push(await req);
  }
  return responses;
}

let created;
let warned;
let warnSpy;
beforeEach(() => {
  created = [];
  warned = [];
  warnSpy = jest.spyOn(logger, "warn").mockImplementation((...args) => { warned.push(args); });
  redis.resetRedisForTests();
  delete process.env.SOCKET_ADAPTER;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PASSWORD;
  delete process.env.TRUST_PROXY_HOPS;
});
afterEach(async () => {
  warnSpy.mockRestore();
  for (const { io } of created) {
    await new Promise(resolve => io.close(resolve));
  }
  redis.resetRedisForTests();
  delete process.env.SOCKET_ADAPTER;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PASSWORD;
  delete process.env.TRUST_PROXY_HOPS;
});

// --- specs: the preserved inventory ------------------------------------------

test("limiter inventory is exactly the 7 preserved scopes with original values", () => {
  expect(GLOBAL_LIMITER_SPEC).toEqual({ name: "global", route: "/api", windowMs: 900000, limit: 100, message: "Too many requests" });
  expect(ROUTE_LIMITER_SPECS.map(s => [s.name, s.route, s.windowMs, s.limit, s.message])).toEqual([
    ["login", "/api/auth/login", 60000, 5, "Too many authentication attempts"],
    ["register", "/api/auth/register", 900000, 5, "Too many registration attempts"],
    ["resend-verification", "/api/auth/resend-verification", 900000, 3, "Too many email requests"],
    ["forgot-password", "/api/auth/forgot-password", 900000, 3, "Too many email requests"],
    ["reset-password", "/api/auth/reset-password", 900000, 5, "Too many reset attempts"],
    ["refresh", "/api/auth/refresh", 60000, 30, "Too many refresh attempts"],
  ]);
  expect(LIMITER_NAMES).toEqual(new Set(["global", "login", "register", "resend-verification", "forgot-password", "reset-password", "refresh"]));
});

test("factory fails closed on bad mode or missing redis client", () => {
  expect(() => createRateLimiters({})).toThrow("FATAL");
  expect(() => createRateLimiters({ mode: "memcached" })).toThrow("FATAL");
  expect(() => createRateLimiters({ mode: "redis" })).toThrow("FATAL");
  expect(() => createRateLimiters({ mode: "redis", store: null })).toThrow("FATAL");
  expect(createRateLimiters({ mode: "local" }).size).toBe(7);
});

// --- healthy path: thresholds, bodies, headers, keys, TTL (redis mode) ------

test.each([
  ["global", 100, "Too many requests", 900000],
  ["login", 5, "Too many authentication attempts", 60000],
  ["register", 5, "Too many registration attempts", 900000],
  ["resend-verification", 3, "Too many email requests", 900000],
  ["forgot-password", 3, "Too many email requests", 900000],
  ["reset-password", 5, "Too many reset attempts", 900000],
  ["refresh", 30, "Too many refresh attempts", 60000],
])("redis %s: first %i pass, next is 429 with preserved body + namespaced key + TTL", async (name, limit, message, windowMs) => {
  const fake = readyStore();
  const limiters = createRateLimiters({ mode: "redis", store: fake });
  const app = bareApp(limiters.get(name));
  const ip = `203.0.113.${10 + limit}`;
  const responses = await fire(app, limit + 1, { ip });
  for (const res of responses.slice(0, limit)) expect(res.status).toBe(200);
  const blocked = responses[limit];
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ error: message });
  expect(parseRateLimit(blocked.headers)).toEqual({ limit: String(limit), remaining: "0", reset: expect.any(String) });
  expect(blocked.headers["ratelimit-policy"]).toBeDefined();
  expect(blocked.headers["retry-after"]).toBeDefined();
  // Namespaced shared key with the window enforced as TTL.
  const key = `ratelimit:${name}:${ip}`;
  expect(fake.keys.get(key).count).toBe(limit + 1);
  expect(fake.ttls).toContainEqual({ key, windowMs });
  expect(degraded(name)).toBe(0);
});

test("redis mode: per-client isolation (XFF selects the bucket)", async () => {
  const fake = readyStore();
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const a = await fire(app, 5, { ip: "203.0.113.21" });
  const b = await fire(app, 5, { ip: "203.0.113.22" });
  expect(a.every(r => r.status === 200)).toBe(true);
  expect(b.every(r => r.status === 200)).toBe(true);
  const a6 = await fire(app, 1, { ip: "203.0.113.21" });
  const b6 = await fire(app, 1, { ip: "203.0.113.22" });
  expect(a6[0].status).toBe(429);
  expect(b6[0].status).toBe(429);
  expect(fake.keys.get("ratelimit:login:203.0.113.21").count).toBe(6);
  expect(fake.keys.get("ratelimit:login:203.0.113.22").count).toBe(6);
});

test("redis mode: expired window resets to a fresh counter (fixed window)", async () => {
  const fake = readyStore();
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const ip = "203.0.113.23";
  await fire(app, 5, { ip });
  expect((await fire(app, 1, { ip }))[0].status).toBe(429);
  fake.expireNow(`ratelimit:login:${ip}`);
  const after = await fire(app, 1, { ip });
  expect(after[0].status).toBe(200);
  expect(parseRateLimit(after[0].headers).remaining).toBe("4");
  expect(fake.keys.get(`ratelimit:login:${ip}`).count).toBe(1);
});

test("local mode: identical 429 contract (status/body/headers) to redis mode", async () => {
  const mkMiddleware = mode => createRateLimiters(
    mode === "redis" ? { mode, store: readyStore() } : { mode }).get("login");
  const contracts = [];
  for (const mode of ["local", "redis"]) {
    const responses = await fire(bareApp(mkMiddleware(mode)), 6, { ip: "203.0.113.24" });
    const parsed = parseRateLimit(responses[5].headers);
    contracts.push({
      status: responses[5].status,
      body: responses[5].body,
      limit: parsed.limit,
      remaining: parsed.remaining,
      policy: responses[5].headers["ratelimit-policy"],
      retryAfterPresent: responses[5].headers["retry-after"] !== undefined,
    });
  }
  expect(contracts[0]).toEqual(contracts[1]);
  expect(contracts[0].status).toBe(429);
});

// --- sharing: two simulated replicas, concurrent first requests -------------

test("two replicas share one counter (limit enforced across both)", async () => {
  const fake = readyStore();
  const replicaA = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const replicaB = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const ip = "203.0.113.25";
  expect((await fire(replicaA, 3, { ip })).every(r => r.status === 200)).toBe(true);
  const viaB = await fire(replicaB, 3, { ip });
  expect(viaB.map(r => r.status)).toEqual([200, 200, 429]);
  expect(viaB[2].body).toEqual({ error: "Too many authentication attempts" });
  expect(fake.keys.get(`ratelimit:login:${ip}`).count).toBe(6);
});

test("50 concurrent first requests: all counted, TTL created exactly once", async () => {
  const fake = readyStore();
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const ip = "203.0.113.26";
  const responses = await Promise.all(
    Array.from({ length: 50 }, () => request(app).get("/").set("X-Forwarded-For", ip)));
  const byStatus = responses.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  expect(byStatus).toEqual({ 200: 5, 429: 45 });
  const key = `ratelimit:login:${ip}`;
  expect(fake.keys.get(key).count).toBe(50);
  expect(fake.ttls.filter(t => t.key === key)).toEqual([{ key, windowMs: 60000 }]);
});

// --- degradation: fail open + LOUD, never a silent local fallback -----------
// NOTE: rate_limit_degraded_total counts failed limiter Redis COMMANDS (>= 1
// per degraded request; the first degraded request per store emits an extra
// one for the script-reload retry). Tests assert the >= 1/request guarantee
// plus the 1:1 metric<->warn LOUD pairing — never the exact retry count.

test("redis command failure: fail open (200), metric + warn, sanitized", async () => {
  const fake = readyStore();
  fake.mode = "error";
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const before = degraded("login");
  const responses = await fire(app, 3, { ip: "203.0.113.27" });
  expect(responses.every(r => r.status === 200)).toBe(true);
  const delta = degraded("login") - before;
  expect(delta).toBeGreaterThanOrEqual(3);
  const ours = warned.filter(([, fields]) => fields.limiter === "login");
  expect(ours.length).toBeGreaterThanOrEqual(3);
  for (const [message, fields] of ours) {
    expect(message).toMatch("failing open");
    expect(fields).toEqual({ limiter: "login", reason: "redis_command_failed" });
  }
  // The adversarial error text (IP + command) reaches nothing observable.
  const exposition = metrics.renderMetrics();
  expect(exposition).not.toMatch("203.0.113.99");
  expect(exposition).not.toMatch("ADVERSARIAL");
  expect(JSON.stringify(warned)).not.toMatch("203.0.113.99");
  expect(JSON.stringify(warned)).not.toMatch("ADVERSARIAL");
  expect(JSON.stringify(responses.map(r => r.body))).not.toMatch("ADVERSARIAL");
});

test("not-ready client: instant fail-open (no 500ms wait, no queue buildup)", async () => {
  const fake = new FakeLimiterRedis(); // status "wait": never connected
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const before = degraded("login");
  const start = Date.now();
  const responses = await fire(app, 5, { ip: "203.0.113.28" });
  const elapsed = Date.now() - start;
  expect(responses.every(r => r.status === 200)).toBe(true);
  const delta = degraded("login") - before;
  expect(delta).toBeGreaterThanOrEqual(5);
  const ours = warned.filter(([, fields]) => fields.limiter === "login");
  expect(ours.length).toBeGreaterThanOrEqual(5);
  expect(elapsed).toBeLessThan(RATE_LIMIT_REDIS_TIMEOUT_MS);
  expect(fake.calls).toHaveLength(0); // rejected before touching the client
  expect(new Set(ours.map(([, fields]) => fields.reason))).toEqual(new Set(["redis_not_ready"]));
});

test("hanging command: bounded by timeout, then fail open", async () => {
  const fake = readyStore();
  fake.mode = "hang";
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("refresh"));
  const before = degraded("refresh");
  const start = Date.now();
  const res = await request(app).get("/").set("X-Forwarded-For", "203.0.113.29");
  const elapsed = Date.now() - start;
  expect(res.status).toBe(200);
  const delta = degraded("refresh") - before;
  expect(delta).toBeGreaterThanOrEqual(1);
  const ours = warned.filter(([, fields]) => fields.limiter === "refresh");
  expect(ours.length).toBeGreaterThanOrEqual(1);
  expect(new Set(ours.map(([, fields]) => fields.reason))).toEqual(new Set(["redis_command_failed"]));
  // One timeout per sendCommand attempt (EVALSHA + script-reload retry), with
  // generous headroom — bounded, never indefinite.
  expect(elapsed).toBeGreaterThanOrEqual(RATE_LIMIT_REDIS_TIMEOUT_MS);
  expect(elapsed).toBeLessThan(RATE_LIMIT_REDIS_TIMEOUT_MS * 3);
}, 15000);

test("NO MemoryStore fallback: same IP far past the limit still passes while degraded", async () => {
  const fake = readyStore();
  fake.mode = "error";
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  // 4x the login limit from ONE bucket: any hidden local counting would 429.
  const responses = await fire(app, 20, { ip: "203.0.113.30" });
  expect(responses.every(r => r.status === 200)).toBe(true);
  expect(fake.keys.size).toBe(0); // and nothing was counted anywhere
});

test("recovery: counting resumes from Redis state; uncounted requests stay uncounted", async () => {
  const fake = readyStore();
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  const ip = "203.0.113.31";
  await fire(app, 2, { ip }); // counted: 2
  fake.mode = "error";
  await fire(app, 3, { ip }); // degraded: pass, uncounted
  fake.mode = "ok";
  const after = await fire(app, 4, { ip }); // resumes at 3,4,5 then 429
  expect(after.map(r => r.status)).toEqual([200, 200, 200, 429]);
  expect(fake.keys.get(`ratelimit:login:${ip}`).count).toBe(6); // 2 + 4, never 9
});

test("pre-connect construction cannot crash (rejection sink) and heals on ready", async () => {
  const fake = new FakeLimiterRedis(); // constructor SCRIPT LOADs reject instantly
  const app = bareApp(createRateLimiters({ mode: "redis", store: fake }).get("login"));
  await new Promise(resolve => setImmediate(resolve)); // let rejections settle: no crash = pass
  fake.status = "ready"; // the startup connect gate lands
  const ip = "203.0.113.32";
  const responses = await fire(app, 6, { ip });
  expect(responses.slice(0, 5).every(r => r.status === 200)).toBe(true);
  expect(responses[5].status).toBe(429); // scripts reloaded, counting normally
});

// --- server.js integration: mounts, order, trust wiring ---------------------

function redisApp() {
  Object.assign(process.env, REDIS_ENV);
  redis.setRedisClientFactoryForTests(() => new FakeLimiterRedis());
  const { createApplication } = require("../src/server");
  const application = createApplication();
  created.push(application);
  redis.getRedis().clients.store.status = "ready"; // post-connect state
  return { application, store: redis.getRedis().clients.store };
}
function localApp(extraEnv = {}) {
  delete process.env.TRUST_PROXY_HOPS;
  Object.assign(process.env, extraEnv);
  const { createApplication } = require("../src/server");
  const application = createApplication();
  created.push(application);
  return application;
}

test("createApplication (redis mode) mounts all 7 limiters with preserved 429s", async () => {
  const { application, store } = redisApp();
  const cases = [
    [GLOBAL_LIMITER_SPEC, "get", "/api/nonexistent-probe", {}],
    ...ROUTE_LIMITER_SPECS.map(spec => [spec, "post", spec.route, { "X-Chess-Client": "trusted-test-client" }]),
  ];
  let octet = 40;
  for (const [spec, method, path, headers] of cases) {
    const ip = `203.0.113.${octet}`; // fresh bucket per route (dodges global)
    octet += 1;
    let last;
    for (let i = 0; i < spec.limit + 1; i += 1) {
      let req = request(application.app)[method](path).set("X-Forwarded-For", ip);
      for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
      last = await req.send({});
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: spec.message });
    expect(parseRateLimit(last.headers).limit).toBe(String(spec.limit));
    expect(store.keys.get(`ratelimit:${spec.name}:${ip}`).count).toBe(spec.limit + 1);
  }
});

test("route limiters count failed attempts (401s), then 429 (skipSuccessfulRequests stays false)", async () => {
  const { application } = redisApp();
  const ip = "203.0.113.60";
  const agent = () => request(application.app).post("/api/auth/login")
    .set("X-Forwarded-For", ip).set("X-Chess-Client", "trusted-test-client");
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await agent().send({})).status);
  // Empty body is rejected (401 Invalid credentials — deliberately not a 400
  // oracle) five times — all counted — then the limiter 429s.
  expect(statuses.slice(0, 5).every(s => s === 401)).toBe(true);
  expect(statuses[5]).toBe(429);
});

test("createApplication honors TRUST_PROXY_HOPS and fails on garbage", () => {
  expect(() => localApp({ TRUST_PROXY_HOPS: "abc" })).toThrow("FATAL: TRUST_PROXY_HOPS");
  expect(() => localApp({ TRUST_PROXY_HOPS: "-1" })).toThrow("FATAL: TRUST_PROXY_HOPS");
  expect(() => localApp({ TRUST_PROXY_HOPS: "1.5" })).toThrow("FATAL: TRUST_PROXY_HOPS");
  expect(() => localApp({ TRUST_PROXY_HOPS: "10" })).toThrow("FATAL: TRUST_PROXY_HOPS");
  expect(localApp({ TRUST_PROXY_HOPS: "0" }).app.get("trust proxy")).toBe(0);
  expect(localApp({ TRUST_PROXY_HOPS: "2" }).app.get("trust proxy")).toBe(2);
  expect(localApp().app.get("trust proxy")).toBe(1);
});

test("trust chain: XFF selects the bucket through the full stack (redis mode)", async () => {
  const { application } = redisApp();
  const agent = ip => request(application.app).post("/api/auth/login")
    .set("X-Forwarded-For", ip).set("X-Chess-Client", "trusted-test-client");
  for (let i = 0; i < 5; i += 1) {
    expect((await agent("203.0.113.61").send({})).status).toBe(401);
    expect((await agent("203.0.113.62").send({})).status).toBe(401);
  }
  expect((await agent("203.0.113.61").send({})).status).toBe(429);
  expect((await agent("203.0.113.62").send({})).status).toBe(429);
  // The direct (non-XFF) bucket is untouched by the XFF traffic.
  const direct = await request(application.app).post("/api/auth/login")
    .set("X-Chess-Client", "trusted-test-client").send({});
  expect(direct.status).toBe(401);
});
