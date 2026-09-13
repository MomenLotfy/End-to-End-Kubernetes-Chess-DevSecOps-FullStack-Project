-- ============================================================
-- 001_init.sql — Chess Database Schema
-- ============================================================

-- ── Users Table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(20)  UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Scores Table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scores (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username         VARCHAR(20) NOT NULL,
  moves            INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  winner           BOOLEAN NOT NULL,
  game_mode        VARCHAR(20) DEFAULT 'local',
  played_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scores_winner     ON scores(winner);
CREATE INDEX IF NOT EXISTS idx_scores_moves      ON scores(moves);
CREATE INDEX IF NOT EXISTS idx_scores_user_id    ON scores(user_id);
CREATE INDEX IF NOT EXISTS idx_scores_played_at  ON scores(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username    ON users(username);

-- ── Updated At Trigger ────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
