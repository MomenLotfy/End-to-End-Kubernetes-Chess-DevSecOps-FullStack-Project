// ============================================================
// config/db.js — PostgreSQL Connection Pool
// ============================================================
const { Pool } = require("pg");
const logger   = require("./logger");

const pool = new Pool({
  host:     process.env.DB_HOST     || "chess-postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "chess_db",
  user:     process.env.DB_USER     || "chess_user",
  password: process.env.DB_PASSWORD || "chess_password",
  max:      10,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error(`PostgreSQL pool error: ${err.message}`);
});

const connectDB = async () => {
  try {
    const client = await pool.connect();
    logger.info("✅ PostgreSQL connected successfully");
    client.release();
  } catch (err) {
    logger.error(`❌ PostgreSQL connection error: ${err.message}`);
    throw err;
  }
};

const query = (text, params) => pool.query(text, params);

module.exports = { pool, connectDB, query };
