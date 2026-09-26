// Socket.io telemetry. Counters are incremented from gameSocket hooks;
// gauges are attached to the live io server + room map (sampled at scrape).
"use strict";

const {
  socketConnects, socketDisconnects, socketAuthFailures,
  socketConnectionsActive, socketRoomsActive, roomOperationFailures,
  roomHydrations, presenceChecks,
} = require("./index");

const KNOWN_DISCONNECT_REASONS = new Set([
  "client namespace disconnect",
  "server namespace disconnect",
  "ping timeout",
  "transport close",
  "transport error",
  "forced close",
  "parse error",
]);

function normalizeReason(reason) {
  return KNOWN_DISCONNECT_REASONS.has(reason) ? reason : "other";
}

let attached = false;
function attach(io, activeRooms) {
  if (attached) return;
  attached = true;
  socketConnectionsActive.collect({}, () => {
    try { return io.engine ? io.engine.clientsCount : 0; } catch { return 0; }
  });
  socketRoomsActive.collect({}, () => {
    try { return activeRooms ? activeRooms.size : 0; } catch { return 0; }
  });
}

// Wave 7 Phase 4: fixed outcome enums (unknown values collapse to the safe
// member so a caller bug can never create unbounded series).
const HYDRATION_OUTCOMES = new Set(["created", "refreshed", "not_found", "invalid", "error"]);
const PRESENCE_OUTCOMES = new Set(["ok", "failed"]);

function onConnect() { try { socketConnects.inc(); } catch { /* drop */ } }
function onDisconnect(reason) {
  try { socketDisconnects.inc({ reason: normalizeReason(reason) }); } catch { /* drop */ }
}
function onAuthFailure() { try { socketAuthFailures.inc(); } catch { /* drop */ } }
function onRoomOperationFailure() { try { roomOperationFailures.inc(); } catch { /* drop */ } }
function onHydration(outcome) {
  try { roomHydrations.inc({ outcome: HYDRATION_OUTCOMES.has(outcome) ? outcome : "error" }); } catch { /* drop */ }
}
function onPresenceCheck(outcome) {
  try { presenceChecks.inc({ outcome: PRESENCE_OUTCOMES.has(outcome) ? outcome : "failed" }); } catch { /* drop */ }
}

module.exports = {
  attach, onConnect, onDisconnect, onAuthFailure, onRoomOperationFailure,
  onHydration, onPresenceCheck,
  normalizeReason, KNOWN_DISCONNECT_REASONS,
};
