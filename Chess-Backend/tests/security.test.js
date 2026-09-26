process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";
process.env.FRONTEND_URL = "http://localhost:3000";

const path = require("path");
const { spawnSync } = require("child_process");
const express = require("express");
const request = require("supertest");
const { upload, inspectAndStoreAvatar } = require("../src/middleware/upload");
const { createApplication, installShutdownHandlers } = require("../src/server");
const { authMiddleware } = require("../src/middleware/auth");
const { signAccessToken, setAccessCookie, setRefreshCookie } = require("../src/services/tokens");
const database = require("../src/config/db");
const shutdown = require("../src/services/shutdown");

test.each([undefined, "chess-jwt-secret-CHANGE-ME-IN-PRODUCTION", "chess-secret-key"])(
  "startup rejects missing or placeholder JWT_SECRET (%s)", value => {
    const env = { ...process.env, NODE_ENV: "test", FRONTEND_URL: "http://localhost:3000" };
    if (value === undefined) delete env.JWT_SECRET; else env.JWT_SECRET = value;
    const script = "require('./src/server').createApplication()";
    const child = spawnSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, ".."), env, encoding: "utf8" });
    expect(child.status).not.toBe(0);
    expect(`${child.stdout}${child.stderr}`).toContain("FATAL: JWT_SECRET");
  }
);

test("authentication accepts HttpOnly cookie credentials and rejects Bearer headers", async () => {
  const sessionQuery = jest.spyOn(database, "query").mockResolvedValue({
    rowCount: 1, rows: [{ session_version: 0, email_verified_at: new Date() }],
  });
  const app = express();
  app.get("/set", (req, res) => {
    setAccessCookie(res, signAccessToken({ id: 9, username: "cookie-user", email: "user@example.test", session_version: 0 }));
    setRefreshCookie(res, "opaque-refresh-token");
    res.status(204).end();
  });
  app.get("/private", require("cookie-parser")(), authMiddleware, (req, res) => res.json({ id: req.user.id }));
  const originalEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const issued = await request(app).get("/set");
  process.env.NODE_ENV = originalEnvironment;
  expect(issued.headers["set-cookie"].every(value => /HttpOnly/i.test(value) && /Secure/i.test(value) && /SameSite=Strict/i.test(value))).toBe(true);
  expect((await request(app).get("/private").set("Authorization", `Bearer ${signAccessToken({ id: 9, username: "x", email: "x@y.test" })}`)).status).toBe(401);
  const accessCookie = issued.headers["set-cookie"].find(value => value.startsWith("chess_access="));
  const authenticated = await request(app).get("/private").set("Cookie", accessCookie);
  expect(authenticated.body).toEqual({ id: 9 });
  sessionQuery.mockRestore();
});

test("responses include strict CSP and security headers", async () => {
  const { app, io } = createApplication();
  const response = await request(app).get("/liveness").set("Origin", "http://localhost:3000");
  expect(response.status).toBe(200);
  expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
  expect(response.headers["content-security-policy"]).toContain("object-src 'none'");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["access-control-allow-credentials"]).toBe("true");
  await new Promise(resolve => io.close(resolve));
});

test("readiness stays unavailable until startup and migrations complete", async () => {
  const { app, io } = createApplication();
  const response = await request(app).get("/readiness");
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ status: "not-ready" });
  await new Promise(resolve => io.close(resolve));
});

test("graceful shutdown closes Socket.io, HTTP and PostgreSQL without abandoning games", async () => {
  const order = [];
  const application = {
    app: { locals: { startupReady: true, shuttingDown: false } },
    io: { close: callback => { order.push("socket"); callback(); } },
    server: { listening: false },
  };
  const poolEnd = jest.spyOn(database.pool, "end").mockImplementation(async () => { order.push("database"); });
  const exit = jest.fn();
  const handlers = installShutdownHandlers(application, { exit });
  await handlers.shutdown("test");
  expect(application.app.locals).toMatchObject({ startupReady: false, shuttingDown: true });
  expect(order).toEqual(["socket", "database"]);
  expect(exit).toHaveBeenCalledWith(0);
  poolEnd.mockRestore();
  handlers.uninstall();
  shutdown.resetShutdownForTests(); // Phase 6: drain state is process-global; restore RUNNING for later tests
});

test("avatar upload rejects a PNG/SVG polyglot by inspecting content", async () => {
  const app = express();
  app.post("/avatar", (req, res, next) => { req.user = { id: 7 }; next(); }, upload.single("avatar"), inspectAndStoreAvatar,
    (req, res) => res.status(201).json({ filename: req.file.filename }));
  app.use((err, req, res, next) => res.status(500).json({ error: "Internal server error" }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const polyglot = Buffer.concat([png, Buffer.from('<svg onload="fetch(\'https://evil.test\')"><script>alert(1)</script></svg>')]);
  const response = await request(app).post("/avatar").attach("avatar", polyglot, { filename: "safe.png", contentType: "image/png" });
  expect(response.status).toBe(400);
  expect(response.body.error).toBe("A valid PNG, JPEG, GIF, or WebP image is required");
});

test("unsafe API requests require an allowed browser origin", async () => {
  const { app, io } = createApplication();
  const missing = await request(app).post("/api/auth/forgot-password").send({ email: "user@example.test" });
  expect(missing.status).toBe(403);
  const crossSite = await request(app).post("/api/auth/forgot-password")
    .set("Origin", "https://attacker.test").set("Sec-Fetch-Site", "cross-site").send({ email: "user@example.test" });
  expect(crossSite.status).toBe(403);
  await new Promise(resolve => io.close(resolve));
});

test("CORS fails closed for an unlisted browser origin", async () => {
  const { app, io } = createApplication();
  const response = await request(app).get("/health").set("Origin", "https://attacker.test");
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: "Request rejected" });
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  await new Promise(resolve => io.close(resolve));
});
