const { Client } = require("../Chess-Backend/node_modules/pg");
const { spawnSync } = require("child_process");

const testDb = "chess_test";
const baseEnv = {
  ...process.env,
  DB_HOST: process.env.DB_HOST || "chess-postgres",
  DB_PORT: process.env.DB_PORT || "5432",
  DB_NAME: testDb,
};

async function main() {
  const admin = new Client({
    host: baseEnv.DB_HOST,
    port: Number(baseEnv.DB_PORT),
    database: process.env.DB_NAME || "chess_db",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDb}`);
  await admin.end();
  const migration = spawnSync(process.execPath, ["run.js"], {
    cwd: "/workspace/Database/migrations", env: baseEnv, stdio: "inherit",
  });
  if (migration.status !== 0) process.exit(migration.status || 1);
  const test = spawnSync("npm", ["run", "test:integration", "--", "--runInBand"], {
    cwd: "/workspace/Chess-Backend", env: baseEnv, stdio: "inherit",
  });
  process.exit(test.status || 0);
}
main().catch(error => { console.error(error); process.exit(1); });
