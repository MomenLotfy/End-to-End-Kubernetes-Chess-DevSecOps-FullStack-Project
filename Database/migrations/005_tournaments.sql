-- ============================================================
-- 005_tournaments.sql — Tournament Mode (single elimination)
-- ============================================================
CREATE TABLE IF NOT EXISTS tournaments (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(80) NOT NULL,
  creator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_players  INTEGER NOT NULL DEFAULT 8,
  status       VARCHAR(12) NOT NULL DEFAULT 'open', -- open | in_progress | finished
  winner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at   TIMESTAMP,
  finished_at  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tournament_players (
  id             SERIAL PRIMARY KEY,
  tournament_id  INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id             SERIAL PRIMARY KEY,
  tournament_id  INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  position       INTEGER NOT NULL, -- ترتيب الماتش جوه الدور (لبناء الدور اللي بعده)
  player1_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  player2_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  winner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | bye | done
  UNIQUE (tournament_id, round, position)
);

CREATE INDEX IF NOT EXISTS idx_tourn_players_tid ON tournament_players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tourn_matches_tid  ON tournament_matches(tournament_id, round);
