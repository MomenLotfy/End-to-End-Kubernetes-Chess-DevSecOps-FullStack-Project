// Wave 7 — S3 avatar telemetry. Labels are fixed enums (operation x result);
// no bucket names, keys, user IDs or filenames ever become label values.
"use strict";

const { s3OperationsTotal, s3OperationDuration, s3LegacyFallbackReads } = require("./index");

const OPERATIONS = new Set(["put", "get", "delete"]);
const RESULTS = new Set(["ok", "missing", "error"]);

function safeOp(operation) {
  return OPERATIONS.has(operation) ? operation : "get";
}

function observeS3(operation, result, seconds) {
  const op = safeOp(operation);
  const res = RESULTS.has(result) ? result : "error";
  try { s3OperationsTotal.inc({ operation: op, result: res }); } catch { /* drop */ }
  try {
    s3OperationDuration.observe({ operation: op }, Math.max(0, Number(seconds) || 0));
  } catch { /* drop */ }
}

function observeLegacyFallback() {
  try { s3LegacyFallbackReads.inc({}); } catch { /* drop */ }
}

module.exports = { observeS3, observeLegacyFallback };
