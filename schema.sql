-- clanker-bot database schema.
-- Applied on startup via CREATE TABLE IF NOT EXISTS. In development, delete the
-- SQLite file to pick up schema changes; there are no migrations by design.

-- Guild-scoped key/value config. `value` holds JSON-encoded data.
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id   TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, key)
);

-- Moderation case ledger. `case_number` is a per-guild sequential counter.
CREATE TABLE IF NOT EXISTS cases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT    NOT NULL,
  case_number  INTEGER NOT NULL,
  user_id      TEXT    NOT NULL,
  moderator_id TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  meta         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cases_guild_case_idx ON cases (guild_id, case_number);

-- Durable queue of future actions (e.g. expire a temp-ban).
CREATE TABLE IF NOT EXISTS scheduled_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  reason     TEXT,
  run_at     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_actions_run_at_idx ON scheduled_actions (run_at);

-- Pending captcha challenges (one active per user per guild).
CREATE TABLE IF NOT EXISTS verification_challenges (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Support tickets (one private channel each).
CREATE TABLE IF NOT EXISTS tickets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT    NOT NULL,
  ticket_number INTEGER NOT NULL,
  channel_id    TEXT    NOT NULL,
  opener_id     TEXT    NOT NULL,
  subject       TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  transcript    TEXT,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_channel_idx ON tickets (channel_id);

-- Canned-response tags (FAQ answers).
CREATE TABLE IF NOT EXISTS tags (
  guild_id   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);
