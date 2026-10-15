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
  created_at INTEGER NOT NULL,
  quiet      INTEGER NOT NULL DEFAULT 0  -- 1 = its member was forgotten: act, record nothing
);
CREATE INDEX IF NOT EXISTS scheduled_actions_run_at_idx ON scheduled_actions (run_at);

-- Pending captcha challenges (one active per user per guild).
CREATE TABLE IF NOT EXISTS verification_challenges (
  guild_id      TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  code          TEXT    NOT NULL,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,  -- wrong guesses so far; SHARED across surfaces
                                  -- (DM + in-channel) so the attempt budget can't be reset
                                  -- by switching where you type, and both stay in sync
  dm_message_id TEXT,             -- the on-join DM captcha message, so a code typed in a
                                  -- DM can rotate in place even after a restart drops the
                                  -- in-memory session (source of truth for reviving it)
  PRIMARY KEY (guild_id, user_id)
);

-- Support tickets (one private channel each).
-- New columns added after launch are also handled by ensureColumns() in db/index.ts
-- so existing databases evolve without dropping ticket history.
CREATE TABLE IF NOT EXISTS tickets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT    NOT NULL,
  ticket_number    INTEGER NOT NULL,
  channel_id       TEXT    NOT NULL,
  opener_id        TEXT    NOT NULL,
  subject          TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  transcript       TEXT,
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  last_activity_at INTEGER,
  closed_by        TEXT,
  close_reason     TEXT,
  auto_close_hold  INTEGER NOT NULL DEFAULT 0  -- 1 = exempt from the inactivity auto-close
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_channel_idx ON tickets (channel_id);

-- Ticket intelligence check: who has passed (and when) so a pass can stay good for a
-- while, and who has failed (and how often in a row) so a cooldown can be enforced
-- across restarts. In-flight challenges live in memory only.
CREATE TABLE IF NOT EXISTS ticket_check_results (
  guild_id  TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  passed_at INTEGER,
  failed_at INTEGER,
  fails     INTEGER NOT NULL DEFAULT 0,  -- consecutive; a pass resets it
  PRIMARY KEY (guild_id, user_id)
) WITHOUT ROWID;

-- Canned-response tags (FAQ answers).
CREATE TABLE IF NOT EXISTS tags (
  guild_id   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);

-- Known-bad scam signatures: domains + image hashes/fingerprints seeded from confirmed honeypot
-- hits (or a manual command). Matched on every message so the next account posting the same scam
-- anywhere is caught. `expires_at` NULL = never (feed entries); self-seeded rows carry a TTL.
CREATE TABLE IF NOT EXISTS scam_signature (
  guild_id   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,  -- 'domain' | 'sha256' | 'triple'
  value      TEXT    NOT NULL,  -- hostname | hex digest | "size:w:h"
  source     TEXT    NOT NULL,  -- 'honeypot' | 'manual' | 'feed'
  case_id    INTEGER,
  hits       INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (guild_id, kind, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS scam_signature_expiry_idx ON scam_signature (expires_at);

-- Server as code: each server's key -> Discord id map, so a spec names things by key and a renamed
-- channel stays the same channel. kind: role | channel | automod | post | asset. A post's key carries
-- its chunk index ("rules#0"); an asset's id is the SHA-256 of the file last applied.
CREATE TABLE IF NOT EXISTS server_state (
  guild_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, kind, key)
) WITHOUT ROWID;

-- The devices the device feed has posted (or found on its first read), so each is posted once.
-- `ident` is a report's name, or the USB id of a device only the usage stats know: those can share a name.
CREATE TABLE IF NOT EXISTS device_feed (
  guild_id TEXT NOT NULL,
  ident    TEXT NOT NULL,
  name     TEXT NOT NULL,
  vidpid   TEXT,
  verdict  TEXT NOT NULL,
  PRIMARY KEY (guild_id, ident)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS device_feed_meta (
  guild_id  TEXT PRIMARY KEY,
  seeded_at INTEGER NOT NULL
);

-- The comparison summary's messages, in order, with what each holds, so a read edits only what changed.
CREATE TABLE IF NOT EXISTS comparison_posts (
  guild_id   TEXT NOT NULL,
  part       INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  PRIMARY KEY (guild_id, part)
) WITHOUT ROWID;

-- Which spec a server follows, and when it was last applied.
CREATE TABLE IF NOT EXISTS server_meta (
  guild_id   TEXT PRIMARY KEY,
  spec       TEXT NOT NULL,
  applied_at INTEGER
);
