-- Security token lifecycle, email verification, recovery, and integrity safeguards.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS account_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose VARCHAR(24) NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_lookup ON account_tokens(token_hash, purpose) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

ALTER TABLE moves ADD COLUMN IF NOT EXISTS promotion VARCHAR(1) CHECK (promotion IN ('q', 'r', 'b', 'n'));
ALTER TABLE moves DROP CONSTRAINT IF EXISTS moves_game_id_move_number_key;
ALTER TABLE moves ADD CONSTRAINT moves_game_id_move_number_key UNIQUE (game_id, move_number);

ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_max_players_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_max_players_check CHECK (max_players IN (4, 8, 16));

-- A CHECK cannot count child rows. This trigger is the DB-level capacity backstop and locks
-- the parent row so concurrent inserts serialize even if an application bypasses the model.
CREATE OR REPLACE FUNCTION enforce_tournament_capacity() RETURNS TRIGGER AS $$
DECLARE capacity INTEGER;
DECLARE current_count INTEGER;
DECLARE tournament_status VARCHAR(12);
BEGIN
  SELECT max_players, status INTO capacity, tournament_status
  FROM tournaments WHERE id = NEW.tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament does not exist' USING ERRCODE = '23503'; END IF;
  IF tournament_status <> 'open' THEN RAISE EXCEPTION 'Tournament is not open' USING ERRCODE = '23514'; END IF;
  SELECT COUNT(*) INTO current_count FROM tournament_players WHERE tournament_id = NEW.tournament_id;
  IF current_count >= capacity THEN RAISE EXCEPTION 'Tournament capacity exceeded' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tournament_capacity_guard ON tournament_players;
CREATE TRIGGER tournament_capacity_guard BEFORE INSERT ON tournament_players
FOR EACH ROW EXECUTE FUNCTION enforce_tournament_capacity();
