-- Full-stack production hardening: revocable sessions and domain constraints.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_session_version_check;
ALTER TABLE users ADD CONSTRAINT users_session_version_check CHECK (session_version >= 0);

ALTER TABLE games DROP CONSTRAINT IF EXISTS games_game_mode_check;
ALTER TABLE games ADD CONSTRAINT games_game_mode_check CHECK (game_mode IN ('local', 'multiplayer', 'ai'));
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_status_check;
ALTER TABLE games ADD CONSTRAINT games_status_check CHECK (status IN ('in_progress', 'finished', 'abandoned'));
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_result_check;
ALTER TABLE games ADD CONSTRAINT games_result_check
  CHECK (result IS NULL OR result IN ('checkmate', 'resign', 'timeout', 'draw', 'disconnect', 'process_failure'));
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_winner_color_check;
ALTER TABLE games ADD CONSTRAINT games_winner_color_check CHECK (winner_color IS NULL OR winner_color IN ('w', 'b'));

ALTER TABLE moves DROP CONSTRAINT IF EXISTS moves_player_color_check;
ALTER TABLE moves ADD CONSTRAINT moves_player_color_check CHECK (player_color IN ('w', 'b'));
ALTER TABLE moves DROP CONSTRAINT IF EXISTS moves_from_square_check;
ALTER TABLE moves ADD CONSTRAINT moves_from_square_check CHECK (from_square ~ '^[a-h][1-8]$');
ALTER TABLE moves DROP CONSTRAINT IF EXISTS moves_to_square_check;
ALTER TABLE moves ADD CONSTRAINT moves_to_square_check CHECK (to_square ~ '^[a-h][1-8]$');
ALTER TABLE moves DROP CONSTRAINT IF EXISTS moves_number_positive_check;
ALTER TABLE moves ADD CONSTRAINT moves_number_positive_check CHECK (move_number > 0);

ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_moves_positive_check;
ALTER TABLE scores ADD CONSTRAINT scores_moves_positive_check CHECK (moves > 0);
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_duration_nonnegative_check;
ALTER TABLE scores ADD CONSTRAINT scores_duration_nonnegative_check CHECK (duration_seconds >= 0);

ALTER TABLE friendships DROP CONSTRAINT IF EXISTS friendships_status_check;
ALTER TABLE friendships ADD CONSTRAINT friendships_status_check CHECK (status IN ('pending', 'accepted'));
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_status_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_status_check CHECK (status IN ('open', 'in_progress', 'finished'));
ALTER TABLE tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_status_check;
ALTER TABLE tournament_matches ADD CONSTRAINT tournament_matches_status_check CHECK (status IN ('pending', 'bye', 'done'));

CREATE INDEX IF NOT EXISTS idx_games_active_room
  ON games(room_id) WHERE status = 'in_progress' AND room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
  ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_one_per_game_user
  ON scores(game_id, user_id) WHERE game_id IS NOT NULL AND user_id IS NOT NULL;
