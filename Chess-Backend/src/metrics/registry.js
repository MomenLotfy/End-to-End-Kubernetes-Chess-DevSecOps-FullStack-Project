// Minimal Prometheus client (zero dependencies — adding prom-client would pull
// native histograms nobody needs here). Cardinality is enforced by CONSTRUCTION:
// every metric declares a FIXED label-name set; unknown or reserved label
// names throw at creation/observation time, and values are length-capped.
"use strict";

const MAX_LABEL_VALUE_LENGTH = 128;

// Label NAMES that would create unbounded series or leak identity. Any metric
// declaring one of these fails fast (tests + startup), never silently.
const RESERVED_LABEL_NAMES = new Set([
  "userid", "user_id", "user", "username", "email",
  "socketid", "socket_id", "socket",
  "jwt", "token", "sessionid", "session_id", "session",
  "requestid", "request_id", "request", "trace_id", "traceid", "span_id",
  "gameid", "game_id", "game", "roomid", "room_id", "room",
  "ip", "client_ip", "clientip", "path", "url", "query", "body",
  "password", "secret", "cookie", "authorization",
]);

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function sanitizeLabelValue(value) {
  let text = typeof value === "string" ? value : String(value);
  text = text.replace(/[\r\n]+/g, " ");
  if (text.length > MAX_LABEL_VALUE_LENGTH) text = text.slice(0, MAX_LABEL_VALUE_LENGTH);
  return text;
}

function escapeLabelValue(text) {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function labelsKey(labelNames, labels) {
  return labelNames.map(name => `${name}=${JSON.stringify(sanitizeLabelValue(labels[name] ?? ""))}`).join(",");
}

function renderLabels(labelNames, labels) {
  if (labelNames.length === 0) return "";
  const parts = labelNames.map(name => `${name}="${escapeLabelValue(sanitizeLabelValue(labels[name] ?? ""))}"`);
  return `{${parts.join(",")}}`;
}

function validateLabelNames(metricName, labelNames) {
  for (const name of labelNames) {
    if (!NAME_RE.test(name)) throw new Error(`metric ${metricName}: invalid label name ${JSON.stringify(name)}`);
    if (RESERVED_LABEL_NAMES.has(name.toLowerCase())) {
      throw new Error(`metric ${metricName}: reserved (unbounded/PII) label name ${JSON.stringify(name)}`);
    }
  }
}

function validateSample(metricName, labelNames, labels) {
  const given = Object.keys(labels || {});
  for (const name of given) {
    if (!labelNames.includes(name)) {
      throw new Error(`metric ${metricName}: undeclared label ${JSON.stringify(name)} (would explode cardinality)`);
    }
  }
}

class Counter {
  constructor(name, help, labelNames = []) {
    validateLabelNames(name, labelNames);
    this.name = name; this.help = help; this.labelNames = labelNames;
    this.series = new Map();
  }
  inc(labels = {}, value = 1) {
    validateSample(this.name, this.labelNames, labels);
    if (!(value >= 0)) throw new Error(`metric ${this.name}: counter increment must be >= 0`);
    const key = labelsKey(this.labelNames, labels);
    const cell = this.series.get(key) || { labels: { ...labels }, value: 0 };
    cell.value += value;
    this.series.set(key, cell);
  }
  exposition(lines) {
    lines.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`);
    for (const cell of this.series.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, cell.labels)} ${cell.value}`);
    }
  }
  resetForTests() { this.series.clear(); }
}

class Gauge {
  constructor(name, help, labelNames = []) {
    validateLabelNames(name, labelNames);
    this.name = name; this.help = help; this.labelNames = labelNames;
    this.series = new Map();
    this.collectors = [];
  }
  // Public point-in-time read (the HTTP drain phase polls in-flight work
  // through this; scraping still goes through exposition()).
  get(labels = {}) { return this._read(labels); }
  set(labels, value) { this._write(labels, Number(value)); }
  inc(labels = {}, value = 1) { this._write(labels, this._read(labels) + value); }
  dec(labels = {}, value = 1) { this._write(labels, this._read(labels) - value); }
  _read(labels) {
    validateSample(this.name, this.labelNames, labels);
    return (this.series.get(labelsKey(this.labelNames, labels)) || { value: 0 }).value;
  }
  _write(labels, value) {
    validateSample(this.name, this.labelNames, labels);
    if (!Number.isFinite(value)) throw new Error(`metric ${this.name}: gauge value must be finite`);
    this.series.set(labelsKey(this.labelNames, labels), { labels: { ...labels }, value });
  }
  // Dynamic value sampled at scrape time (pool stats, socket counts).
  collect(labels, fn) {
    validateSample(this.name, this.labelNames, labels);
    this.collectors.push({ labels: { ...labels }, fn });
  }
  exposition(lines) {
    lines.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`);
    for (const cell of this.series.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, cell.labels)} ${cell.value}`);
    }
    for (const collector of this.collectors) {
      let value = 0;
      try { value = Number(collector.fn()); } catch { value = 0; }
      if (!Number.isFinite(value)) value = 0;
      lines.push(`${this.name}${renderLabels(this.labelNames, collector.labels)} ${value}`);
    }
  }
  resetForTests() { this.series.clear(); /* collectors stay: they are wiring, not data */ }
}

class Histogram {
  constructor(name, help, labelNames = [], buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
    validateLabelNames(name, labelNames);
    this.name = name; this.help = help; this.labelNames = labelNames;
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.series = new Map();
  }
  observe(labels = {}, value) {
    validateSample(this.name, this.labelNames, labels);
    if (!(value >= 0)) throw new Error(`metric ${this.name}: histogram observation must be >= 0`);
    const key = labelsKey(this.labelNames, labels);
    let cell = this.series.get(key);
    if (!cell) {
      cell = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, cell);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) cell.counts[i] += 1;
    }
    cell.sum += value;
    cell.count += 1;
  }
  exposition(lines) {
    lines.push(`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`);
    for (const cell of this.series.values()) {
      const base = renderLabels(this.labelNames, cell.labels);
      const withLe = le => (base ? base.slice(0, -1) + `,le="${le}"}` : `{le="${le}"}`);
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket${withLe(this.buckets[i])} ${cell.counts[i]}`);
      }
      lines.push(`${this.name}_bucket${withLe("+Inf")} ${cell.count}`);
      lines.push(`${this.name}_sum${base} ${cell.sum}`);
      lines.push(`${this.name}_count${base} ${cell.count}`);
    }
  }
  resetForTests() { this.series.clear(); }
}

class Registry {
  constructor() { this.metrics = []; }
  register(metric) { this.metrics.push(metric); return metric; }
  exposition() {
    const lines = [];
    for (const metric of this.metrics) metric.exposition(lines);
    return `${lines.join("\n")}\n`;
  }
}

module.exports = {
  Registry, Counter, Gauge, Histogram,
  RESERVED_LABEL_NAMES, MAX_LABEL_VALUE_LENGTH, sanitizeLabelValue,
};
