-- ============================================================
-- 002_game_features.sql — Profile fields + Persistent Games/Moves
-- يمهّد لـ: Profile Page, Avatar Upload, ELO, Game Replay, Opening Book
-- ============================================================

-- ── توسيع جدول users ──────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio         VARCHAR(160);
ALTER TABLE users ADD COLUMN IF NOT EXISTS elo_rating  INTEGER NOT NULL DEFAULT 1200;

CREATE INDEX IF NOT EXISTS idx_users_elo ON users(elo_rating DESC);

-- ── جدول games: كل لعبة سطر واحد (بدل ما تفضل بس في الميموري) ──
CREATE TABLE IF NOT EXISTS games (
  id              SERIAL PRIMARY KEY,
  room_id         VARCHAR(12) UNIQUE,                 -- معرف الغرفة (multiplayer) أو NULL في local
  white_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  black_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  white_username  VARCHAR(20),
  black_username  VARCHAR(20),
  game_mode       VARCHAR(20) NOT NULL DEFAULT 'local',  -- local | multiplayer | ai
  status          VARCHAR(20) NOT NULL DEFAULT 'in_progress', -- in_progress | finished | abandoned
  result          VARCHAR(20),                         -- checkmate | resign | timeout | draw | disconnect
  winner_color    VARCHAR(1),                           -- 'w' | 'b' | NULL (draw)
  started_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_games_room_id        ON games(room_id);
CREATE INDEX IF NOT EXISTS idx_games_white_user_id  ON games(white_user_id);
CREATE INDEX IF NOT EXISTS idx_games_black_user_id  ON games(black_user_id);
CREATE INDEX IF NOT EXISTS idx_games_status         ON games(status);

-- ── جدول moves: كل حركة سطر، أساس الـ Replay + Opening Book ──
CREATE TABLE IF NOT EXISTS moves (
  id              SERIAL PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  move_number     INTEGER NOT NULL,          -- ترتيب الحركة داخل اللعبة (1, 2, 3...)
  player_color    VARCHAR(1) NOT NULL,       -- 'w' | 'b'
  from_square     VARCHAR(2) NOT NULL,       -- e.g. 'e2'
  to_square       VARCHAR(2) NOT NULL,       -- e.g. 'e4'
  piece           VARCHAR(2) NOT NULL,       -- e.g. 'wP'
  captured_piece  VARCHAR(2),                -- لو فيه أكل
  san             VARCHAR(10),               -- Standard Algebraic Notation، مفيد للعرض والـ Opening Book
  fen_after       TEXT,                      -- حالة الرقعة كاملة بعد الحركة (يسهّل الـ Replay/Hints)
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_moves_game_id ON moves(game_id, move_number);

-- ── ربط scores بلعبة فعلية (اختياري - للألعاب القديمة يفضل NULL) ──
ALTER TABLE scores ADD COLUMN IF NOT EXISTS game_id INTEGER REFERENCES games(id) ON DELETE SET NULL;
