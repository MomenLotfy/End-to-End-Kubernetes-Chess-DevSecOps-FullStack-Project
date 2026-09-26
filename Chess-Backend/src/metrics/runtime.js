// Runtime health sampler: 1s unref'd timer measuring event-loop delay.
// Started by startServer() only (never in unit tests, never by import).
"use strict";

const { eventloopLag } = require("./index");

const TICK_MS = 1000;
let timer = null;

function startRuntimeSampler() {
  if (timer) return timer;
  let last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lagSeconds = Math.max(0, (now - last - TICK_MS) / 1000);
    try { eventloopLag.set({}, lagSeconds); } catch { /* never break the loop */ }
    last = now;
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function stopRuntimeSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startRuntimeSampler, stopRuntimeSampler, TICK_MS };
