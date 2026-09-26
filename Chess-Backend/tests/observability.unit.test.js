process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";
process.env.FRONTEND_URL = "http://localhost:3000";

const request = require("supertest");
const { Counter, Gauge, Histogram, Registry } = require("../src/metrics/registry");
const metrics = require("../src/metrics");
const { operationOf } = require("../src/metrics/db");
const { normalizeReason } = require("../src/metrics/socket");
const { redact, sanitizeUrl } = require("../src/config/logSanitize");
const { createApplication } = require("../src/server");

test("registry rejects identity/unbounded label names at creation", () => {
  for (const name of ["user_id", "email", "socket_id", "game_id", "request_id", "path", "token"]) {
    expect(() => new Counter("x_total", "x", [name])).toThrow(/reserved/);
  }
});

test("registry rejects undeclared label names at observation", () => {
  const counter = new Counter("x_total", "x", ["route"]);
  expect(() => counter.inc({ route: "/a", user_id: "9" })).toThrow(/undeclared/);
});

test("exposition renders valid Prometheus text (counter/histogram/gauge)", () => {
  const registry = new Registry();
  const counter = registry.register(new Counter("demo_total", "demo.", ["route"]));
  const gauge = registry.register(new Gauge("demo_gauge", "demo.", []));
  const histogram = registry.register(new Histogram("demo_seconds", "demo.", ["route"], [0.1, 1]));
  counter.inc({ route: "/api/x" }, 2);
  gauge.set({}, 7);
  histogram.observe({ route: "/api/x" }, 0.05);
  histogram.observe({ route: "/api/x" }, 5);
  const text = registry.exposition();
  expect(text).toContain("# HELP demo_total demo.");
  expect(text).toContain("# TYPE demo_total counter");
  expect(text).toContain('demo_total{route="/api/x"} 2');
  expect(text).toContain("demo_gauge 7");
  expect(text).toContain('demo_seconds_bucket{route="/api/x",le="0.1"} 1');
  expect(text).toContain('demo_seconds_bucket{route="/api/x",le="+Inf"} 2');
  expect(text).toContain('demo_seconds_count{route="/api/x"} 2');
  expect(text).toMatch(/demo_seconds_sum\{route="\/api\/x"\} 5\.0?5/);
});

test("route labels use patterns (never raw paths); status classes bounded", () => {
  expect(metrics.routeLabel({ baseUrl: "/api/game", route: { path: "/:id(\\d+)" } }))
    .toBe("/api/game/:id(\\d+)");
  expect(metrics.routeLabel({})).toBe("unmatched");
  expect(metrics.statusClass(200)).toBe("2xx");
  expect(metrics.statusClass(429)).toBe("4xx");
  expect(metrics.statusClass(503)).toBe("5xx");
});

test("db operations collapse to the SQL verb allowlist", () => {
  expect(operationOf("SELECT 1")).toBe("SELECT");
  expect(operationOf({ text: "  insert into scores values (1)" })).toBe("INSERT");
  expect(operationOf("VACUUM FULL scores")).toBe("OTHER");
});

test("socket disconnect reasons collapse unknown values to other", () => {
  expect(normalizeReason("ping timeout")).toBe("ping timeout");
  expect(normalizeReason("something-new")).toBe("other");
});

test("redaction scrubs secrets, urls, keys and jwts", () => {
  const out = redact({
    password: "hunter2",
    nested: { token: "abc", keep: "yes" },
    url: "postgresql://chess_user:hunter2@db:5432/chess_db",
    key: "AKIAIOSFODNN7EXAMPLE",
    auth: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy-signature-value",
    list: ["AKIAIOSFODNN7EXAMPLE"],
  });
  expect(out.password).toBe("[REDACTED]");
  expect(out.nested.token).toBe("[REDACTED]");
  expect(out.nested.keep).toBe("yes");
  expect(out.url).not.toContain("hunter2");
  expect(out.key).toBe("[REDACTED_AWS_KEY]");
  expect(out.auth).toBe("[REDACTED]");
  expect(out.list).toEqual(["[REDACTED_AWS_KEY]"]);
});

test("sanitizeUrl redacts sensitive query params + jwt path segments", () => {
  expect(sanitizeUrl("/api/x?token=abc123&page=2")).toBe("/api/x?token=[REDACTED]&page=2");
  expect(sanitizeUrl("/api/auth/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy-signature-value"))
    .toContain("[REDACTED_JWT]");
  expect(sanitizeUrl("/api/game/123")).toBe("/api/game/123");
});

test("GET /metrics exposes Prometheus text; requests carry X-Request-Id", async () => {
  const { app } = createApplication();
  const probe = await request(app).get("/liveness");
  expect(probe.status).toBe(200);
  expect(probe.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  await request(app).get("/does-not-exist");
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  expect(res.text).toContain("# TYPE http_requests_total counter");
  expect(res.text).toContain('route="unmatched"');
  expect(res.text).toContain("process_uptime_seconds");
  expect(res.text).toContain("chess_build_info");
});

test("server errors surface as 5xx series (real login-without-DB path)", async () => {
  const { app } = createApplication();
  const res = await request(app).post("/api/auth/login")
    .set("Origin", "http://localhost:3000")
    .send({ email: "a@b.test", password: "x" });
  expect(res.status).toBe(500);
  const text = metrics.renderMetrics();
  expect(text).toContain('http_requests_total{method="POST",route="/api/auth/login",status_class="5xx"}');
});

test("pool errors increment the db error counter", () => {
  const { pool } = require("../src/config/db");
  const textBefore = metrics.renderMetrics();
  const countBefore = Number((textBefore.match(/app_errors_total\{component="db"\} (\d+)/) || [])[1] || "0");
  pool.emit("error", new Error("boom"));
  const textAfter = metrics.renderMetrics();
  const countAfter = Number((textAfter.match(/app_errors_total\{component="db"\} (\d+)/) || [])[1]);
  expect(countAfter).toBe(countBefore + 1);
});

test("aborted connections release in-flight without recording", () => {
  const { EventEmitter } = require("events");
  const { metricsMiddleware } = require("../src/metrics/http");
  const gaugeVal = () => {
    const m = metrics.renderMetrics().match(/^http_requests_in_flight (\S+)$/m);
    return Number(m[1]);
  };
  const base = gaugeVal();
  const req = { path: "/api/x", method: "GET", headers: {}, baseUrl: "" };
  const res = new EventEmitter();
  res.statusCode = 200;
  metricsMiddleware(req, res, () => {});
  expect(gaugeVal()).toBe(base + 1);
  res.emit("close");
  expect(gaugeVal()).toBe(base);
});
