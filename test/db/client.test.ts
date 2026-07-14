import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/client";
import { getConfigRow, setConfigRow } from "../../src/repositories/config.repository";

test("schema loads and config rows round-trip", () => {
  const db = createDatabase(":memory:");
  setConfigRow(db, "g1", "mod_log_channel_id", '"123"', 1);
  expect(getConfigRow(db, "g1", "mod_log_channel_id")).toBe('"123"');
});

test("createDatabase creates a missing parent directory", () => {
  const root = join(tmpdir(), `clanker-test-${crypto.randomUUID()}`);
  const dbPath = join(root, "nested", "bot.sqlite");
  try {
    createDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
