// Log redaction (Wave 6 §10). Two entry points:
// - redact(value): deep-scrubs objects logged via winston (keys + string
//   patterns). Circular-safe, depth-capped, never throws.
// - sanitizeUrl(url): scrubs query params + JWT-like path segments for the
//   morgan access log (morgan never sees bodies, but it DOES see raw URLs).
"use strict";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE = /password|passwd|secret|token|cookie|authorization|^auth$|jwt|session|api[-_]?key|private[-_]?key|credential|set-cookie|email/i;
// NOTE: email matches SENSITIVE_KEY_RE on purpose (object keys like
// "email" are PII in free-form logs); explicit login flows log only outcomes.

const PATTERNS = [
  // Database URLs (any scheme carrying credentials).
  { re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis(rediss)?):\/\/[^\s"'`]+/gi, replacement: "$1://[REDACTED]" },
  // AWS access key IDs.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  // AWS secret-shaped 40-char base64 (only when labeled, to avoid FPs — see key pass).
  // JWTs / opaque bearer-ish tokens (3 or 2 long base64url segments).
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,})?/g, replacement: "[REDACTED_JWT]" },
  // Slack-style tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]+\b/g, replacement: "[REDACTED]" },
];

const SENSITIVE_QUERY_KEY_RE = /token|code|secret|password|passwd|key|auth|session|jwt|email/i;

function scrubString(text) {
  let out = text;
  for (const { re, replacement } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

function redact(value, depth = 0, seen = new WeakSet()) {
  try {
    if (depth > 10) return REDACTED;
    if (typeof value === "string") return scrubString(value);
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (value instanceof Error) {
      return { name: value.name, message: scrubString(value.message || ""), stack: scrubString(value.stack || "") };
    }
    if (Array.isArray(value)) return value.map(item => redact(item, depth + 1, seen));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redact(item, depth + 1, seen);
    }
    return out;
  } catch {
    return REDACTED;
  }
}

function sanitizeUrl(rawUrl) {
  try {
    const text = String(rawUrl || "");
    const withJwtScrubbed = text.replace(
      /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,})?/g,
      "[REDACTED_JWT]"
    );
    const queryIndex = withJwtScrubbed.indexOf("?");
    if (queryIndex === -1) return withJwtScrubbed;
    const path = withJwtScrubbed.slice(0, queryIndex);
    const scrubbed = withJwtScrubbed.slice(queryIndex + 1).split("&").map(pair => {
      const equals = pair.indexOf("=");
      const key = equals === -1 ? pair : pair.slice(0, equals);
      if (SENSITIVE_QUERY_KEY_RE.test(key)) return `${key}=${REDACTED}`;
      return pair;
    });
    return `${path}?${scrubbed.join("&")}`;
  } catch {
    return REDACTED;
  }
}

module.exports = { redact, sanitizeUrl, scrubString, REDACTED };
