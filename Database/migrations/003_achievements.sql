-- ============================================================
-- 003_achievements.sql — Achievements / Badges
-- ============================================================

CREATE TABLE IF NOT EXISTS achievements (
  key         VARCHAR(40) PRIMARY KEY,
  name        VARCHAR(60) NOT NULL,
  description VARCHAR(160) NOT NULL,
  icon        VARCHAR(10) NOT NULL DEFAULT '🏅'
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key    VARCHAR(40) NOT NULL REFERENCES achievements(key) ON DELETE CASCADE,
  earned_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, achievement_key)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);

-- بذور الإنجازات الأساسية
INSERT INTO achievements (key, name, description, icon) VALUES
  ('first_win',       'First Blood',        'Win your first game',                          '🥇'),
  ('wins_5',          'Getting Good',        'Win 5 games',                                   '🎖️'),
  ('wins_10',         'Chess Enthusiast',    'Win 10 games',                                  '🏆'),
  ('wins_25',         'Grandmaster Grind',   'Win 25 games',                                  '👑'),
  ('quick_win',       'Blitz Master',        'Win a game in 15 moves or fewer',               '⚡'),
  ('marathon',        'Marathon Match',      'Play a game lasting 60 moves or more',          '🏃'),
  ('flawless',        'Flawless Victory',    'Win a game without losing a single piece',      '💎'),
  ('comeback',        'The Comeback',        'Win a game after losing your queen',            '🔥'),
  ('first_game',      'First Steps',         'Play your first game',                          '♟️')
ON CONFLICT (key) DO NOTHING;
