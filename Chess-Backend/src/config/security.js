const PLACEHOLDER_SECRETS = new Set([
  "chess-secret-key",
  "chess-jwt-secret-CHANGE-ME-IN-PRODUCTION",
]);

function requireJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret || PLACEHOLDER_SECRETS.has(secret) || secret.length < 32) {
    throw new Error(
      "FATAL: JWT_SECRET must be set to a unique secret of at least 32 characters; documented placeholder values are forbidden."
    );
  }
  return secret;
}

function allowedOrigins(env = process.env) {
  const raw = env.FRONTEND_URLS || env.FRONTEND_URL;
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error("FATAL: FRONTEND_URL or FRONTEND_URLS is required in production.");
    }
    return ["http://localhost:3000"];
  }
  const origins = raw.split(",").map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`FATAL: Invalid CORS origin: ${origin}`);
    }
  }
  return origins;
}

// Wave 7 Phase 5: TRUST_PROXY_HOPS is load-bearing for rate limiting — it
// selects which X-Forwarded-For position becomes req.ip, i.e. the limiter
// key. Garbage (NaN/negative/fractional) previously flowed straight into
// Express with undefined trust semantics; now it is FATAL at startup.
// Correct values: 1 in compose (client -> nginx -> backend) AND 1 in EKS
// (client -> ALB -> nginx -> backend, because nginx real_ip rewrites the XFF
// chain so the backend again sees exactly one trusted hop). The Helm value is
// pinned to "1" and the Wave 7 checker enforces it.
function trustProxyHops(env = process.env) {
  const raw = env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === "" ? "1" : env.TRUST_PROXY_HOPS;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 9) {
    throw new Error(`FATAL: TRUST_PROXY_HOPS must be an integer 0-9 (got ${JSON.stringify(String(raw)).slice(0, 32)}).`);
  }
  return hops;
}

function validateEnvironment(env = process.env) {
  const configuration = { jwtSecret: requireJwtSecret(env), origins: allowedOrigins(env), trustProxyHops: trustProxyHops(env) };
  if (env.NODE_ENV === "production" && configuration.origins.some(origin => !origin.startsWith("https://"))) {
    throw new Error("FATAL: Production frontend origins must use HTTPS.");
  }
  if (env.NODE_ENV === "production" && (!env.SMTP_HOST || !env.EMAIL_FROM)) {
    throw new Error("FATAL: SMTP_HOST and EMAIL_FROM are required in production for account verification and recovery.");
  }
  if (env.NODE_ENV === "production" && ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].some(key => !env[key])) {
    throw new Error("FATAL: DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD are required in production.");
  }
  return configuration;
}

module.exports = { PLACEHOLDER_SECRETS, requireJwtSecret, allowedOrigins, trustProxyHops, validateEnvironment };
