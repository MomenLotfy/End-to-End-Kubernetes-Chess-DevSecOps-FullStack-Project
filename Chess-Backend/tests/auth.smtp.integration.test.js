process.env.JWT_SECRET = "integration-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.EMAIL_FROM = "Chess Integration <chess@example.test>";
process.env.SMTP_REQUIRE_TLS = "true";
process.env.SMTP_TLS_REJECT_UNAUTHORIZED = "false";

const { SMTPServer } = require("smtp-server");
const request = require("supertest");
const { pool } = require("../src/config/db");

let smtp;
let app;
const messages = [];
const origin = "http://localhost:3000";
const post = (client, path, body) => client.post(path).set("Origin", origin).set("Sec-Fetch-Site", "same-origin").send(body);
const cookie = (response, name) => response.headers["set-cookie"]?.find(value => value.startsWith(`${name}=`))?.split(";")[0];
const tokenFrom = raw => {
  const decodedQuotedPrintable = raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
  return decodeURIComponent(decodedQuotedPrintable.match(/[?&]token=([A-Za-z0-9_-]+)/)[1]);
};

beforeAll(async () => {
  const database = await pool.query("SELECT current_database() AS name");
  if (!/_test$/.test(database.rows[0].name)) throw new Error("Integration tests require a database name ending in _test");
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH"],
    onData(stream, session, callback) {
      let raw = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => { raw += chunk; });
      stream.on("end", () => { messages.push({ raw, secure: session.secure }); callback(); });
    },
  });
  await new Promise((resolve, reject) => {
    smtp.once("error", reject);
    smtp.listen(0, "127.0.0.1", resolve);
  });
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(smtp.server.address().port);
  ({ app } = require("../src/server").createApplication());
});

afterAll(async () => {
  await pool.query("TRUNCATE refresh_tokens, account_tokens, user_achievements, scores, moves, games, users RESTART IDENTITY CASCADE");
  await new Promise(resolve => smtp.close(resolve));
  await pool.end();
});

test("verification, resend, login, refresh reuse, reset, invalidation and logout use real PostgreSQL and STARTTLS SMTP", async () => {
  const agent = request.agent(app);
  const username = `auth${Date.now()}`.slice(0, 20);
  const email = `${username}@example.test`;
  const password = "Correct-Horse-Battery-1";

  expect((await post(agent, "/api/auth/register", { username, email, password })).status).toBe(201);
  expect(messages).toHaveLength(1);
  expect(messages[0].secure).toBe(true);
  const firstVerification = tokenFrom(messages[0].raw);

  expect((await post(agent, "/api/auth/resend-verification", { email })).status).toBe(200);
  expect(messages).toHaveLength(2);
  expect(messages[1].secure).toBe(true);
  const currentVerification = tokenFrom(messages[1].raw);
  expect(currentVerification).toHaveLength(43);
  expect(currentVerification).not.toBe(firstVerification);
  expect((await post(agent, "/api/auth/verify-email", { token: currentVerification })).status).toBe(200);
  expect((await post(agent, "/api/auth/verify-email", { token: firstVerification })).status).toBe(400);

  const loggedIn = await post(agent, "/api/auth/login", { email, password });
  expect(loggedIn.status).toBe(200);
  expect(cookie(loggedIn, "chess_access")).toMatch(/^chess_access=/);
  const firstRefresh = cookie(loggedIn, "chess_refresh");
  expect(firstRefresh).toMatch(/^chess_refresh=/);

  const rotated = await post(agent, "/api/auth/refresh", {});
  expect(rotated.status).toBe(200);
  const secondRefresh = cookie(rotated, "chess_refresh");
  expect(secondRefresh).not.toBe(firstRefresh);
  expect((await request(app).post("/api/auth/refresh").set("Origin", origin).set("Cookie", firstRefresh).send({})).status).toBe(401);
  expect((await request(app).post("/api/auth/refresh").set("Origin", origin).set("Cookie", secondRefresh).send({})).status).toBe(401);

  expect((await post(agent, "/api/auth/login", { email, password })).status).toBe(200);
  expect((await post(agent, "/api/auth/forgot-password", { email })).status).toBe(200);
  const resetMessage = messages.findLast(message => message.raw.includes("Reset your Chess password"));
  expect(resetMessage.secure).toBe(true);
  const resetToken = tokenFrom(resetMessage.raw);
  const newPassword = "Correct-Horse-Battery-2";
  expect((await post(agent, "/api/auth/reset-password", { token: resetToken, password: newPassword })).status).toBe(200);
  expect((await agent.get("/api/auth/profile")).status).toBe(401);
  expect((await post(agent, "/api/auth/login", { email, password })).status).toBe(401);
  expect((await post(agent, "/api/auth/login", { email, password: newPassword })).status).toBe(200);

  expect((await post(agent, "/api/auth/logout", {})).status).toBe(204);
  expect((await agent.get("/api/auth/profile")).status).toBe(401);
});

test("negative authentication and CSRF cases fail closed", async () => {
  expect((await request(app).post("/api/auth/login").send({ email: "none@example.test", password: "wrong" })).status).toBe(403);
  expect((await request(app).post("/api/auth/login").set("Origin", "https://attacker.test").send({ email: "none@example.test", password: "wrong" })).status).toBe(403);
  expect((await post(request(app), "/api/auth/login", { email: "not-an-email", password: "wrong" })).status).toBe(401);
});
