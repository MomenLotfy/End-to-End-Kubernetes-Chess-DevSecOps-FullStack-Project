const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function sslConfiguration(env = process.env) {
  if (env.DB_SSL !== "true") return undefined;
  if (!env.DB_SSL_CA) throw new Error("DB_SSL_CA is required when DB_SSL=true");
  return { ca: env.DB_SSL_CA.replace(/\\n/g, "\n"), rejectUnauthorized: true };
}

const pool = new Pool({
  host: process.env.DB_HOST || "chess-postgres",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "chess_db",
  user: process.env.DB_USER || "chess_user",
  password: process.env.DB_PASSWORD || "chess_password",
  ssl: sslConfiguration(),
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
});

const MIGRATIONS_DIR = __dirname;
const LOCK_ID = 724_337_771;
const checksum = sql => crypto.createHash("sha256").update(sql).digest("hex");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      checksum CHAR(64),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum CHAR(64)");
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await ensureMigrationsTable(client);
    const appliedResult = await client.query("SELECT filename, checksum FROM schema_migrations");
    const applied = new Map(appliedResult.rows.map(row => [row.filename, row.checksum]));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(file => /^\d{3}_.+\.sql$/.test(file)).sort();
    if (!files.length) throw new Error("No migration files were found");

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const digest = checksum(sql);
      if (applied.has(file)) {
        const stored = applied.get(file);
        if (stored && stored !== digest) throw new Error(`Applied migration was modified: ${file}`);
        if (!stored) await client.query("UPDATE schema_migrations SET checksum=$2 WHERE filename=$1", [file, digest]);
        console.log(`SKIP ${file}`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        const inserted = await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [file, digest]
        );
        if (inserted.rowCount !== 1) throw new Error("migration record was not inserted");
        await client.query("COMMIT");
        console.log(`APPLIED ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration failed ${file}: ${error.message}`);
      }
    }
    console.log(`MIGRATIONS_COMPLETE count=${files.length}`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
    await pool.end();
  }
}

run().catch(error => {
  console.error(`MIGRATION_ERROR ${error.message}`);
  process.exitCode = 1;
});
