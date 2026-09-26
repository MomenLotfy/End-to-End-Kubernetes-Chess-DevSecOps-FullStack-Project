// Wave 7 Phase 3 — rematch vote coordination.
//
// The backend is EXPLICITLY one of two modes (chosen by SOCKET_ADAPTER at
// startup, never switched at runtime):
//   local — in-memory Map<gameId, Set<userId>>. Single-replica dev/test only.
//   redis — Valkey SET `rematch:{gameId}` + 1h TTL. ALL replicas share it.
//
// In redis mode there is deliberately NO local fallback: a Redis failure
// throws RematchUnavailable (controlled  error to the player + metrics),
// never a silent process-local Set that would split-brain a rematch across
// replicas. Redis holds COORDINATION (who voted), not truth: authorization
// (is this socket a player? is the game finished?) stays in gameSocket.js +
// PostgreSQL row locks, exactly as before.
//
// Key safety: gameId/userId must be positive integers (type-validated at
// this boundary even though callers pass authed values). Keys carry a TTL,
// so abandoned votes evaporate; resolution/departure paths delete eagerly.
"use strict";

const logger = require("../config/logger");
const { observeCommand, onRematchRedisError } = require("../metrics/redis");

const REMATCH_TTL_SECONDS = 3600;
const KEY_PREFIX = "rematch:";

class RematchUnavailable extends Error {
  constructor() {
    super("Rematch service unavailable");
    this.name = "RematchUnavailable";
  }
}

function keyForGame(gameId) {
  if (!Number.isInteger(gameId) || gameId <= 0) {
    throw new Error("Refusing rematch key for invalid game id");
  }
  return `${KEY_PREFIX}${gameId}`;
}

function assertUserId(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("Refusing rematch vote for invalid user id");
  }
}

// --- local backend (explicit single-replica mode, never a fallback) ---
function createLocalBackend() {
  const votes = new Map();
  return {
    mode: "local",
    async addVote(gameId, userId) {
      const key = keyForGame(gameId);
      assertUserId(userId);
      let set = votes.get(key);
      if (!set) {
        set = new Set();
        votes.set(key, set);
      }
      set.add(userId);
      return { count: set.size };
    },
    async removeVote(gameId, userId) {
      try {
        votes.get(keyForGame(gameId))?.delete(userId);
        return true;
      } catch {
        return false;
      }
    },
    async clearVotes(gameId) {
      try {
        votes.delete(keyForGame(gameId));
        return true;
      } catch {
        return false;
      }
    },
  };
}

// --- redis backend (shared; fail-closed, TTL-bounded) ---
function createRedisBackend(store) {
  if (!store) throw new Error("FATAL: rematch Redis backend requires the store client");
  return {
    mode: "redis",
    async addVote(gameId, userId) {
      const key = keyForGame(gameId);
      assertUserId(userId);
      try {
        await observeCommand("store", "sadd", () => store.sadd(key, String(userId)));
        await observeCommand("store", "expire", () => store.expire(key, REMATCH_TTL_SECONDS));
        const count = await observeCommand("store", "scard", () => store.scard(key));
        return { count: Number(count) || 0 };
      } catch (error) {
        if (error instanceof RematchUnavailable) throw error;
        onRematchRedisError("add");
        logger.warn("Rematch vote failed (Redis unavailable — failing closed)");
        throw new RematchUnavailable();
      }
    },
    // Best-effort departure cleanup: returns false instead of throwing, so
    // disconnect/leave paths never break on a cache blip. The TTL is the
    // backstop (stale votes evaporate within the hour).
    async removeVote(gameId, userId) {
      try {
        const key = keyForGame(gameId);
        assertUserId(userId);
        await observeCommand("store", "srem", () => store.srem(key, String(userId)));
        return true;
      } catch (error) {
        onRematchRedisError("remove");
        logger.warn("Rematch vote cleanup failed (TTL backstop applies)");
        return false;
      }
    },
    async clearVotes(gameId) {
      try {
        await observeCommand("store", "del", () => store.del(keyForGame(gameId)));
        return true;
      } catch (error) {
        onRematchRedisError("clear");
        logger.warn("Rematch vote clear failed (TTL backstop applies)");
        return false;
      }
    },
  };
}

// --- Process-wide singleton (initialized once at startup) ---
let backend = null;

function initRematchVotes({ mode, store } = {}) {
  if (backend) return backend;
  const resolved = mode || (process.env.SOCKET_ADAPTER || "local").toLowerCase();
  if (resolved !== "local" && resolved !== "redis") {
    throw new Error(`FATAL: SOCKET_ADAPTER must be local|redis (got ${resolved})`);
  }
  backend = resolved === "redis" ? createRedisBackend(store) : createLocalBackend();
  logger.info(`Rematch votes backend: ${backend.mode}`);
  return backend;
}

function rematchVotes() {
  // Lazy init for direct initSocket() users (tests, scripts): env-driven,
  // same backends as the server path. No cycle: redis.js never requires us.
  if (!backend) {
    const mode = (process.env.SOCKET_ADAPTER || "local").toLowerCase();
    if (mode !== "local" && mode !== "redis") {
      throw new Error(`FATAL: SOCKET_ADAPTER must be local|redis (got ${mode})`);
    }
    if (mode === "redis") {
      const { getRedis } = require("./redis");
      initRematchVotes({ mode, store: getRedis().clients.store });
    } else {
      initRematchVotes({ mode: "local" });
    }
  }
  return backend;
}

function setRematchBackendForTests(next) { backend = next || null; }

module.exports = {
  REMATCH_TTL_SECONDS, KEY_PREFIX, RematchUnavailable,
  keyForGame, createLocalBackend, createRedisBackend,
  initRematchVotes, rematchVotes, setRematchBackendForTests,
};
