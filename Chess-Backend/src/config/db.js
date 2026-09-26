const { Pool } = require("pg");
const logger = require("./logger");
const { instrumentPool } = require("../metrics/db");
const { appErrorsTotal } = require("../metrics");

function sslConfiguration(env = process.env) {
  if (env.DB_SSL !== "true") return undefined;
  if (!env.DB_SSL_CA) throw new Error("FATAL: DB_SSL_CA is required when DB_SSL=true");
  return { ca: env.DB_SSL_CA.replace(/\\n/g, "\n"), rejectUnauthorized: true };
}

const pool = new Pool({
  host: process.env.DB_HOST || "chess-postgres",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "chess_db",
  user: process.env.DB_USER || "chess_user",
  password: process.env.DB_PASSWORD || "chess_password",
  ssl: sslConfiguration(),
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 10000),
  application_name: "chess-backend",
});

instrumentPool(pool);

pool.on("error", error => {
  logger.error("PostgreSQL pool error", { error: error.message });
  try { appErrorsTotal.inc({ component: "db" }); } catch { /* drop */ }
});

async function connectDB() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info("PostgreSQL connected");
  } finally { client.release(); }
}

const query = (text, params) => pool.query(text, params);
module.exports = { pool, connectDB, query, sslConfiguration };
