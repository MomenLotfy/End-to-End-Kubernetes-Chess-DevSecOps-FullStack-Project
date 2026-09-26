// Wave 7 Phase 6: graceful-shutdown telemetry. All labels are fixed enums
// (unknown values collapse to the safe member so a caller bug can never
// create unbounded series). No identity, no paths, no secrets — the drain
// path must stay as low-cardinality as the steady state.
"use strict";

const {
  shutdownState, shutdownRejected, shutdownPhases, shutdownSignals,
} = require("./index");

const REJECT_SOURCES = new Set(["http", "socket", "room"]);
const PHASES = new Set(["settle", "http", "room", "socket", "cache", "pg"]);
const PHASE_RESULTS = new Set(["completed", "timeout", "forced"]);
const SIGNALS = new Set(["SIGTERM", "SIGINT"]);
const SIGNAL_ACTIONS = new Set(["accepted", "ignored"]);

function setShutdownState(value) {
  try { shutdownState.set({}, Number(value)); } catch { /* drop */ }
}

function onRejectedWork(source) {
  try {
    shutdownRejected.inc({ source: REJECT_SOURCES.has(source) ? source : "http" });
  } catch { /* drop */ }
}

function onPhase(phase, result) {
  try {
    shutdownPhases.inc({
      phase: PHASES.has(phase) ? phase : "settle",
      result: PHASE_RESULTS.has(result) ? result : "completed",
    });
  } catch { /* drop */ }
}

function onSignal(signal, action) {
  try {
    shutdownSignals.inc({
      signal: SIGNALS.has(signal) ? signal : "SIGTERM",
      action: SIGNAL_ACTIONS.has(action) ? action : "ignored",
    });
  } catch { /* drop */ }
}

module.exports = {
  setShutdownState, onRejectedWork, onPhase, onSignal,
  REJECT_SOURCES, PHASES, PHASE_RESULTS, SIGNALS, SIGNAL_ACTIONS,
};
