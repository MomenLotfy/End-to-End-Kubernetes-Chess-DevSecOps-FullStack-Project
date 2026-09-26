// Wave 7 Phase 3 — Redis telemetry. Labels are fixed enums ONLY:
// client ∈ {adapter-pub, adapter-sub, store}, command ∈ allowlist + OTHER,
// rematch operation ∈ {add, remove, clear}. Never game/user/socket/room IDs,
// never keys, never error text.
"use strict";

const {
  redisClientErrors, redisConnected, redisReconnects,
  redisCommandDuration, rematchRedisErrors,
} = require("./index");

const CLIENTS = new Set(["adapter-pub", "adapter-sub", "store"]);
const COMMANDS = new Set([
  "sadd", "srem", "scard", "expire", "del", "ping", "incr", "ttl",
]);
const REMATCH_OPS = new Set(["add", "remove", "clear"]);

function safeClient(name) {
  return CLIENTS.has(name) ? name : "store";
}

function onClientError(clientName) {
  try { redisClientErrors.inc({ client: safeClient(clientName) }); } catch { /* drop */ }
}

function onReconnecting(clientName) {
  try { redisReconnects.inc({ client: safeClient(clientName) }); } catch { /* drop */ }
}

function collectConnected(clientName, statusFn) {
  try { redisConnected.collect({ client: safeClient(clientName) }, statusFn); } catch { /* drop */ }
}

async function observeCommand(clientName, command, fn) {
  const cmd = COMMANDS.has(command) ? command : "OTHER";
  const start = process.hrtime.bigint();
  try {
    return await fn();
  } catch (error) {
    onClientError(clientName);
    throw error;
  } finally {
    try {
      redisCommandDuration.observe(
        { client: safeClient(clientName), command: cmd },
        Math.max(0, Number(process.hrtime.bigint() - start) / 1e9)
      );
    } catch { /* drop */ }
  }
}

function onRematchRedisError(operation) {
  const op = REMATCH_OPS.has(operation) ? operation : "add";
  try { rematchRedisErrors.inc({ operation: op }); } catch { /* drop */ }
}

module.exports = {
  CLIENTS, onClientError, onReconnecting, collectConnected,
  observeCommand, onRematchRedisError,
};
