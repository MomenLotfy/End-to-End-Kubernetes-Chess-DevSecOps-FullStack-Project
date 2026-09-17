process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";

const express = require("express");
const fs = require("fs");
const path = require("path");
const request = require("supertest");

const mockState = {
  tournament: { id: 10, status: "open", max_players: 4 },
  players: new Set([1, 2, 3]),
  lockTail: Promise.resolve(),
};

jest.mock("../src/config/db", () => ({
  query: jest.fn(),
  pool: {
    connect: jest.fn(async () => {
      let unlock = null;
      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, " ").trim();
          if (normalized === "BEGIN") return { rows: [], rowCount: 0 };
          if (normalized === "COMMIT" || normalized === "ROLLBACK") {
            if (unlock) { unlock(); unlock = null; }
            return { rows: [], rowCount: 0 };
          }
          if (normalized.includes("FROM tournaments WHERE id=$1 FOR UPDATE")) {
            const previous = mockState.lockTail;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            mockState.lockTail = previous.then(() => gate);
            await previous;
            unlock = release;
            return { rows: [{ ...mockState.tournament }], rowCount: 1 };
          }
          if (normalized.startsWith("SELECT id FROM tournament_players")) {
            return mockState.players.has(params[1]) ? { rows: [{ id: params[1] }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          if (normalized.startsWith("SELECT COUNT(*)::int AS count")) {
            return { rows: [{ count: mockState.players.size }], rowCount: 1 };
          }
          if (normalized.startsWith("INSERT INTO tournament_players")) {
            if (mockState.players.size >= mockState.tournament.max_players) throw new Error("Tournament capacity exceeded");
            mockState.players.add(params[1]);
            return { rows: [{ id: params[1] }], rowCount: 1 };
          }
          throw new Error(`Unhandled SQL in concurrency test: ${normalized}`);
        },
        release() { if (unlock) unlock(); },
      };
    }),
  },
}));

jest.mock("../src/middleware/auth", () => ({
  authMiddleware(req, res, next) {
    req.user = { id: Number(req.get("x-test-user")), username: `user${req.get("x-test-user")}` };
    next();
  },
}));

const tournamentRoutes = require("../src/routes/tournaments");

test("migration installs a database-level capacity trigger", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "Database", "migrations", "006_security_integrity.sql"), "utf8");
  expect(migration).toContain("CREATE TRIGGER tournament_capacity_guard BEFORE INSERT ON tournament_players");
  expect(migration).toContain("FROM tournaments WHERE id = NEW.tournament_id FOR UPDATE");
  expect(migration).toContain("Tournament capacity exceeded");
});

test("parallel HTTP joins cannot exceed max_players", async () => {
  mockState.players = new Set([1, 2, 3]);
  mockState.lockTail = Promise.resolve();
  const app = express();
  app.use(express.json());
  app.use("/api/tournaments", tournamentRoutes);

  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) => request(app).post("/api/tournaments/10/join").set("x-test-user", String(index + 20)))
  );

  expect(mockState.players.size).toBe(4);
  expect(responses.filter(response => response.status === 200)).toHaveLength(1);
  expect(responses.filter(response => response.status === 400)).toHaveLength(11);
  expect(responses.filter(response => response.body.error === "Tournament is full")).toHaveLength(11);
});
