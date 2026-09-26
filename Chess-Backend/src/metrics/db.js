// Database telemetry. Pool gauges are sampled at scrape time (zero overhead
// per query); per-query duration/error observation wraps pool.query ONCE via
// instrumentPool(). The ONLY per-query label is the SQL verb allowlist.
"use strict";

const { dbPoolConnections, dbQueryDuration, dbQueryErrors } = require("./index");

const OPERATIONS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "WITH",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",
  "SET", "SHOW", "EXPLAIN", "LISTEN", "NOTIFY",
]);

function operationOf(queryTextOrConfig) {
  const text = typeof queryTextOrConfig === "string"
    ? queryTextOrConfig
    : (queryTextOrConfig && queryTextOrConfig.text) || "";
  const verb = text.trim().split(/\s+/, 1)[0].toUpperCase().replace(/[^A-Z]/g, "");
  return OPERATIONS.has(verb) ? verb : "OTHER";
}

function instrumentPool(pool) {
  if (pool.__chessMetricsInstrumented) return pool;
  pool.__chessMetricsInstrumented = true;
  dbPoolConnections.collect({ state: "total" }, () => pool.totalCount || 0);
  dbPoolConnections.collect({ state: "idle" }, () => pool.idleCount || 0);
  dbPoolConnections.collect({ state: "waiting" }, () => pool.waitingCount || 0);
  const originalQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    const operation = operationOf(args[0]);
    const start = process.hrtime.bigint();
    try {
      return await originalQuery(...args);
    } catch (error) {
      try { dbQueryErrors.inc({ operation }); } catch { /* drop */ }
      throw error;
    } finally {
      try {
        dbQueryDuration.observe({ operation }, Math.max(0, Number(process.hrtime.bigint() - start) / 1e9));
      } catch { /* drop */ }
    }
  };
  return pool;
}

module.exports = { instrumentPool, operationOf };
