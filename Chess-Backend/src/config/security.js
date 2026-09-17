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

function validateEnvironment(env = process.env) {
  const configuration = { jwtSecret: requireJwtSecret(env), origins: allowedOrigins(env) };
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

module.exports = { PLACEHOLDER_SECRETS, requireJwtSecret, allowedOrigins, validateEnvironment };
