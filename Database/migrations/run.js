// ============================================================
// Database/migrations/run.js — Simple SQL Migration Runner
// npm run migrate
// بيشغّل أي ملف .sql جديد في المجلد ده بالترتيب الأبجدي،
// وبيسجّل اللي اتنفذ في جدول schema_migrations عشان ميتكررش.
// ============================================================
const fs   = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  host:     process.env.DB_HOST     || "chess-postgres",
  port:     parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME     || "chess_db",
  user:     process.env.DB_USER     || "chess_user",
  password: process.env.DB_PASSWORD || "chess_password",
});

const MIGRATIONS_DIR = __dirname;

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(client) {
  const res = await client.query("SELECT filename FROM schema_migrations");
  return new Set(res.rows.map(r => r.filename));
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith(".sql"))
      .sort(); // 001_..., 002_... بالترتيب

    if (files.length === 0) {
      console.log("لا يوجد ملفات migration.");
      return;
    }

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`⏭  تخطي (متنفذ من قبل): ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`▶  تشغيل: ${file}`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`✅ تم: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`فشل تنفيذ ${file}: ${err.message}`);
      }
    }

    console.log("🎉 كل الـ migrations اتنفذت بنجاح.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("❌ Migration error:", err.message);
  process.exit(1);
});
