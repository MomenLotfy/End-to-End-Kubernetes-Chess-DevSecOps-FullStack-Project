-- Add persistent authoritative board state to games.
ALTER TABLE games
ADD COLUMN IF NOT EXISTS board_fen TEXT;
