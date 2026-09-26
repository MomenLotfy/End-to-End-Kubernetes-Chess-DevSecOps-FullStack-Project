// Wave 7 Phase 3 — rematch vote backend tests. Redis is a Map-backed fake;
// the fail-closed contract (no silent local fallback) is asserted explicitly.
"use strict";

process.env.JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.NODE_ENV = "test";

const votes = require("../src/services/rematchVotes");
const metrics = require("../src/metrics");

function fakeStore(shared = new Map(), behavior = {}) {
  const calls = [];
  const sets = shared;
  const get = key => {
    let set = sets.get(key);
    if (!set) {
      set = new Set();
      sets.set(key, set);
    }
    return set;
  };
  return {
    calls,
    expirations: new Map(),
    async sadd(key, member) {
      calls.push(["sadd", key, member]);
      if (behavior.failOn && behavior.failOn.has("sadd")) throw new Error("WRONGTYPE fake");
      get(key).add(String(member));
      return 1;
    },
    async srem(key, member) {
      calls.push(["srem", key, member]);
      if (behavior.failOn && behavior.failOn.has("srem")) throw new Error("READONLY fake");
      get(key).delete(String(member));
      return 1;
    },
    async scard(key) {
      calls.push(["scard", key]);
      return get(key).size;
    },
    async expire(key, seconds) {
      calls.push(["expire", key, seconds]);
      this.expirations.set(key, seconds);
      return 1;
    },
    async del(key) {
      calls.push(["del", key]);
      if (behavior.failOn && behavior.failOn.has("del")) throw new Error("READONLY fake");
      return sets.delete(key) ? 1 : 0;
    },
  };
}

const metricVal = (name, labels) => {
  const m = metrics.renderMetrics().match(new RegExp(`^${name}${labels} ([0-9.eE+-]+)$`, "m"));
  return m ? Number(m[1]) : 0;
};

beforeEach(() => {
  votes.setRematchBackendForTests(null);
  delete process.env.SOCKET_ADAPTER;
});
afterEach(() => {
  votes.setRematchBackendForTests(null);
  delete process.env.SOCKET_ADAPTER;
});

test("keyForGame namespaces integer game ids and rejects everything else", () => {
  expect(votes.keyForGame(7)).toBe("rematch:7");
  for (const bad of [0, -3, 1.5, NaN, "7", "7:users", null, undefined, {}, []]) {
    expect(() => votes.keyForGame(bad)).toThrow("Refusing rematch key");
  }
});

test("local backend: votes accumulate, duplicates are idempotent", async () => {
  const local = votes.createLocalBackend();
  expect(local.mode).toBe("local");
  expect(await local.addVote(9, 101)).toEqual({ count: 1 });
  expect(await local.addVote(9, 101)).toEqual({ count: 1 }); // idempotent
  expect(await local.addVote(9, 202)).toEqual({ count: 2 });
  expect(await local.addVote(10, 101)).toEqual({ count: 1 }); // other game isolated
  await local.removeVote(9, 101);
  expect(await local.addVote(9, 303)).toEqual({ count: 2 });
  await local.clearVotes(9);
  expect(await local.addVote(9, 404)).toEqual({ count: 1 });
});

test("local backend validates ids", async () => {
  const local = votes.createLocalBackend();
  await expect(local.addVote("x", 1)).rejects.toThrow("Refusing rematch key");
  await expect(local.addVote(1, -2)).rejects.toThrow("Refusing rematch vote");
});

test("redis backend: shared set + TTL on every vote", async () => {
  const store = fakeStore();
  const backend = votes.createRedisBackend(store);
  expect(backend.mode).toBe("redis");
  expect(await backend.addVote(11, 501)).toEqual({ count: 1 });
  expect(await backend.addVote(11, 501)).toEqual({ count: 1 }); // idempotent
  expect(await backend.addVote(11, 502)).toEqual({ count: 2 });
  const voteCalls = store.calls.filter(([cmd]) => cmd === "sadd");
  expect(voteCalls).toHaveLength(3);
  expect(voteCalls[0][1]).toBe("rematch:11");
  expect(store.expirations.get("rematch:11")).toBe(3600); // TTL always applied
  expect(await backend.addVote(12, 501)).toEqual({ count: 1 }); // isolated keys
});

test("redis backend: two logical replicas share one vote set", async () => {
  const shared = new Map();
  const replicaA = votes.createRedisBackend(fakeStore(shared));
  const replicaB = votes.createRedisBackend(fakeStore(shared));
  expect(await replicaA.addVote(21, 701)).toEqual({ count: 1 });
  // B sees A's vote: quorum is reachable across replicas.
  expect(await replicaB.addVote(21, 702)).toEqual({ count: 2 });
});

test("redis backend validates ids before touching Redis", async () => {
  const store = fakeStore();
  const backend = votes.createRedisBackend(store);
  await expect(backend.addVote("1; DROP", 1)).rejects.toThrow("Refusing rematch key");
  await expect(backend.addVote(1, 0)).rejects.toThrow("Refusing rematch vote");
  expect(store.calls).toHaveLength(0);
});

test("addVote fails CLOSED when Redis is down (no local fallback)", async () => {
  const store = fakeStore(new Map(), { failOn: new Set(["sadd"]) });
  const backend = votes.createRedisBackend(store);
  const rematchBefore = metricVal("rematch_redis_errors_total", '{operation="add"}');
  const clientBefore = metricVal("redis_client_errors_total", '{client="store"}');
  const first = backend.addVote(31, 801).catch(error => error);
  const second = backend.addVote(31, 802).catch(error => error);
  for (const error of await Promise.all([first, second])) {
    expect(error).toBeInstanceOf(votes.RematchUnavailable);
    expect(error.message).toBe("Rematch service unavailable"); // no Redis details
  }
  // Still failing (never healed into a silent local Set)...
  await expect(backend.addVote(31, 803)).rejects.toBeInstanceOf(votes.RematchUnavailable);
  expect(metricVal("rematch_redis_errors_total", '{operation="add"}')).toBe(rematchBefore + 3);
  expect(metricVal("redis_client_errors_total", '{client="store"}')).toBe(clientBefore + 3);
  expect(backend.mode).toBe("redis");
});

test("removeVote/clearVotes never throw (TTL is the backstop)", async () => {
  const store = fakeStore(new Map(), { failOn: new Set(["srem", "del"]) });
  const backend = votes.createRedisBackend(store);
  await expect(backend.removeVote(41, 901)).resolves.toBe(false);
  await expect(backend.clearVotes(41)).resolves.toBe(false);
  expect(metricVal("rematch_redis_errors_total", '{operation="remove"}')).toBeGreaterThanOrEqual(1);
  expect(metricVal("rematch_redis_errors_total", '{operation="clear"}')).toBeGreaterThanOrEqual(1);
  const healthy = fakeStore();
  const ok = votes.createRedisBackend(healthy);
  await ok.addVote(41, 901);
  await expect(ok.removeVote(41, 901)).resolves.toBe(true);
  expect(await ok.addVote(41, 902)).toEqual({ count: 1 });
  await expect(ok.clearVotes(41)).resolves.toBe(true);
  expect(await ok.addVote(41, 903)).toEqual({ count: 1 });
});

test("lazy accessor refuses garbage SOCKET_ADAPTER (no silent local)", () => {
  process.env.SOCKET_ADAPTER = "memcached";
  expect(() => votes.rematchVotes()).toThrow("FATAL: SOCKET_ADAPTER must be local|redis");
  delete process.env.SOCKET_ADAPTER;
  expect(votes.rematchVotes().mode).toBe("local");
});

test("initRematchVotes selects the backend from explicit config only", () => {
  expect(votes.initRematchVotes({ mode: "local" }).mode).toBe("local");
  votes.setRematchBackendForTests(null);
  expect(() => votes.initRematchVotes({ mode: "redis" })).toThrow("requires the store client");
  expect(() => votes.initRematchVotes({ mode: "memcached" })).toThrow("FATAL");
  const backend = votes.initRematchVotes({ mode: "redis", store: fakeStore() });
  expect(backend.mode).toBe("redis");
});
