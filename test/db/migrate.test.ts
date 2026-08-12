import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/index";
import { getTicketByChannel, setTicketHold } from "../../src/db/tickets";

// Every other test opens ":memory:", where schema.sql declares the current columns and the
// ensureColumns() ALTER path never runs. That path is the one part of a schema change that
// touches live data, so it gets exercised here against a real file on the OLD shape.
const dbPath = join(tmpdir(), `clanker-migrate-test-${process.pid}.sqlite`);

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

test("an existing tickets table gains auto_close_hold without losing its rows", () => {
  const old = new Database(dbPath, { create: true });
  old.exec(`CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, ticket_number INTEGER NOT NULL,
    channel_id TEXT NOT NULL, opener_id TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL,
    transcript TEXT, created_at INTEGER NOT NULL, closed_at INTEGER, last_activity_at INTEGER,
    closed_by TEXT, close_reason TEXT)`);
  old.exec(`INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at)
    VALUES ('g', 7, 'c7', 'u', 'existing history', 'open', 1)`);
  old.close();

  const db = createDatabase(dbPath);
  // The pre-existing ticket survives, and back-fills as not-held rather than NULL: the
  // /ticket hold toggle reads this as a boolean, and a NOT NULL column added without a
  // DEFAULT is rejected by SQLite outright, taking the bot down on startup.
  const migrated = getTicketByChannel(db, "c7");
  expect(migrated?.subject).toBe("existing history");
  expect(migrated?.autoCloseHold).toBe(0);
  expect(setTicketHold(db, "c7", true)).toBe(true);
  expect(getTicketByChannel(db, "c7")?.autoCloseHold).toBe(1);
  db.close();
});
