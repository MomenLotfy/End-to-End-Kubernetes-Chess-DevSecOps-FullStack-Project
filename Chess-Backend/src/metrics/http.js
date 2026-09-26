// HTTP metrics middleware. Mounted FIRST (before routes) so every request is
// counted; labels are resolved at res-finish when req.route is known.
// Observability endpoints are excluded (no self-scrape feedback loop).
"use strict";

const {
  routeLabel, statusClass, httpRequestsTotal, httpRequestDuration,
  httpRequestsInFlight, httpRequestSizeBytes,
} = require("./index");

const EXCLUDED_PATHS = new Set(["/metrics", "/liveness", "/readiness", "/health", "/internal/enter-drain"]);

function getInflightRequests() {
  try {
    const value = httpRequestsInFlight.get();
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function metricsMiddleware(req, res, next) {
  if (EXCLUDED_PATHS.has(req.path)) return next();
  const start = process.hrtime.bigint();
  try { httpRequestsInFlight.inc(); } catch { /* drop */ }
  const contentLength = Number(req.headers["content-length"] || 0);
  // finish = completed response (record everything); close without finish =
  // aborted connection (release the gauge, record nothing — never leak +1).
  let settled = false;
  const settle = finished => {
    if (settled) return;
    settled = true;
    try {
      httpRequestsInFlight.dec();
      if (!finished) return;
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const method = String(req.method || "UNKNOWN").slice(0, 16).toUpperCase();
      const route = routeLabel(req);
      const klass = statusClass(res.statusCode);
      httpRequestsTotal.inc({ method, route, status_class: klass });
      httpRequestDuration.observe({ method, route, status_class: klass }, Math.max(0, seconds));
      if (Number.isFinite(contentLength) && contentLength > 0) {
        httpRequestSizeBytes.observe({ method, route }, contentLength);
      }
    } catch {
      // Metrics must never break responses; a failed observation is dropped.
    }
  };
  res.on("finish", () => settle(true));
  res.on("close", () => settle(false));
  next();
}

module.exports = { metricsMiddleware, EXCLUDED_PATHS, getInflightRequests };
