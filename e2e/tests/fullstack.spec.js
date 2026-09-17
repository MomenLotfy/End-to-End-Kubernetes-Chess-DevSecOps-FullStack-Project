const { test, expect } = require("@playwright/test");

const baseURL = process.env.E2E_BASE_URL || "https://chess-frontend:8443";
const mailpitURL = process.env.MAILPIT_URL || "http://mailpit:8025";
const headers = { Origin: baseURL, "Sec-Fetch-Site": "same-origin" };
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function post(context, path, data) {
  return context.request.post(path, { data, headers });
}

async function latestMailToken(address, subject) {
  let token;
  await expect.poll(async () => {
    const list = await fetch(`${mailpitURL}/api/v1/messages`).then(response => response.json());
    for (const summary of list.messages || []) {
      if (summary.Subject !== subject || !(summary.To || []).some(to => to.Address === address)) continue;
      const message = await fetch(`${mailpitURL}/api/v1/message/${summary.ID}`).then(response => response.json());
      const match = String(message.Text || "").match(/[?&]token=([A-Za-z0-9_-]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }
    return token;
  }).toBeTruthy();
  return token;
}

async function registerVerifyLogin(browser, label) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: headers });
  const id = `${label}${Date.now()}${Math.floor(Math.random() * 10000)}`.slice(0, 20);
  const email = `${id}@example.test`;
  const password = `Safe-${id}-Password!`;
  expect((await post(context, "/api/auth/register", { username: id, email, password })).status()).toBe(201);
  const token = await latestMailToken(email, "Verify your Chess account");
  expect((await post(context, "/api/auth/verify-email", { token })).status()).toBe(200);
  expect((await post(context, "/api/auth/login", { email, password })).status()).toBe(200);
  return { context, email, password, username: id };
}

async function installSocket(page) {
  await page.goto("/");
  await page.addScriptTag({ url: "/socket.io/socket.io.js" });
  await page.evaluate(() => {
    window.socketEvents = {};
    window.testSocket = window.io(window.location.origin, { transports: ["websocket"], withCredentials: true });
    for (const name of ["connect", "room_created", "game_start", "move_made", "game_ended", "error", "opponent_disconnected"]) {
      window.socketEvents[name] = [];
      window.testSocket.on(name, payload => window.socketEvents[name].push(payload ?? true));
    }
  });
  await expect.poll(() => page.evaluate(() => window.testSocket.connected)).toBe(true);
}

async function emit(page, name, payload) {
  await page.evaluate(({ name, payload }) => window.testSocket.emit(name, payload), { name, payload });
}

async function events(page, name) {
  return page.evaluate(name => window.socketEvents[name], name);
}

test("production auth, email, session, upload, security and two-browser multiplayer", async ({ browser }) => {
  const alice = await registerVerifyLogin(browser, "alice");
  const bob = await registerVerifyLogin(browser, "bob");
  const alicePage = await alice.context.newPage();
  const bobPage = await bob.context.newPage();

  await alicePage.goto("/");
  await expect(alicePage.getByText(alice.username, { exact: true }).first()).toBeVisible();
  await alicePage.reload();
  await expect(alicePage.getByText(alice.username, { exact: true }).first()).toBeVisible();

  const unauthenticated = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: headers });
  expect((await unauthenticated.request.get("/api/auth/profile")).status()).toBe(401);
  expect((await unauthenticated.request.post("/api/auth/forgot-password", {
    data: { email: alice.email }, headers: { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
  })).status()).toBe(403);
  expect((await alice.context.request.post("/api/leaderboard/save", { data: { winner: true, moves: 1 }, headers })).status()).toBe(410);

  const firstAvatar = await alice.context.request.post("/api/auth/avatar", {
    headers,
    multipart: { avatar: { name: "fake.txt", mimeType: "text/plain", buffer: tinyPng } },
  });
  expect(firstAvatar.status()).toBe(200);
  const firstUrl = (await firstAvatar.json()).user.avatar_url;
  const secondAvatar = await alice.context.request.post("/api/auth/avatar", {
    headers,
    multipart: { avatar: { name: "avatar.jpg", mimeType: "image/jpeg", buffer: tinyPng } },
  });
  expect(secondAvatar.status()).toBe(200);
  expect((await alice.context.request.get(firstUrl)).status()).toBe(404);
  const malformed = Buffer.concat([tinyPng, Buffer.from("<svg><script>alert(1)</script></svg>")]);
  expect((await alice.context.request.post("/api/auth/avatar", {
    headers, multipart: { avatar: { name: "avatar.png", mimeType: "image/png", buffer: malformed } },
  })).status()).toBe(400);

  expect((await post(alice.context, "/api/auth/forgot-password", { email: alice.email })).status()).toBe(200);
  const resetToken = await latestMailToken(alice.email, "Reset your Chess password");
  const newPassword = `${alice.password}-new`;
  expect((await post(alice.context, "/api/auth/reset-password", { token: resetToken, password: newPassword })).status()).toBe(200);
  expect((await alice.context.request.get("/api/auth/profile")).status()).toBe(401);
  expect((await post(alice.context, "/api/auth/login", { email: alice.email, password: alice.password })).status()).toBe(401);
  expect((await post(alice.context, "/api/auth/login", { email: alice.email, password: newPassword })).status()).toBe(200);

  await installSocket(alicePage);
  await installSocket(bobPage);
  await emit(alicePage, "create_room", {});
  await expect.poll(async () => (await events(alicePage, "room_created")).length).toBe(1);
  const roomId = (await events(alicePage, "room_created"))[0].roomId;
  await emit(bobPage, "join_room", { roomId });
  await expect.poll(async () => (await events(alicePage, "game_start")).length).toBe(1);
  await expect.poll(async () => (await events(bobPage, "game_start")).length).toBe(1);

  await emit(bobPage, "make_move", { roomId, move: { from: "e7", to: "e5" } });
  await expect.poll(async () => (await events(bobPage, "error")).some(error => error.message === "Not your turn")).toBe(true);
  await Promise.all([
    emit(alicePage, "make_move", { roomId, move: { from: "f2", to: "f3" } }),
    emit(alicePage, "make_move", { roomId, move: { from: "f2", to: "f3" } }),
  ]);
  await expect.poll(async () => (await events(alicePage, "move_made")).length).toBe(1);
  await emit(bobPage, "make_move", { roomId, move: { from: "e7", to: "e5" } });
  await expect.poll(async () => (await events(bobPage, "move_made")).length).toBe(2);

  await bobPage.evaluate(() => window.testSocket.disconnect());
  await expect.poll(async () => (await events(alicePage, "opponent_disconnected")).length).toBe(1);
  await bobPage.evaluate(() => window.testSocket.connect());
  await expect.poll(() => bobPage.evaluate(() => window.testSocket.connected)).toBe(true);
  await emit(bobPage, "join_room", { roomId });
  await expect.poll(async () => (await events(bobPage, "game_start")).length).toBeGreaterThan(1);

  expect((await post(alice.context, "/api/auth/refresh", {})).status()).toBe(200);
  await emit(alicePage, "make_move", { roomId, move: { from: "g2", to: "g4" } });
  await expect.poll(async () => (await events(alicePage, "move_made")).length).toBe(3);
  await emit(bobPage, "make_move", { roomId, move: { from: "d8", to: "h4" } });
  await expect.poll(async () => (await events(alicePage, "game_ended")).length).toBe(1);
  const ended = (await events(alicePage, "game_ended"))[0];
  expect(ended.result).toBe("checkmate");
  expect(ended.eloChange.white.new).toBeLessThan(ended.eloChange.white.old);
  expect(ended.eloChange.black.new).toBeGreaterThan(ended.eloChange.black.old);

  await emit(alicePage, "accept_rematch", { roomId });
  await emit(bobPage, "accept_rematch", { roomId });
  await expect.poll(async () => (await events(alicePage, "game_start")).length).toBeGreaterThan(1);

  expect((await post(alice.context, "/api/auth/logout", {})).status()).toBe(204);
  expect((await alice.context.request.get("/api/auth/profile")).status()).toBe(401);
  await unauthenticated.close();
  await alice.context.close();
  await bob.context.close();
});
