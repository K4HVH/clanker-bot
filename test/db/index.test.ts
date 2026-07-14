import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, many } from "../../src/db/index";

test("schema loads all tables", () => {
  const db = createDatabase(":memory:");
  const names = many<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).map((r) => r.name);
  for (const table of [
    "guild_config",
    "cases",
    "scheduled_actions",
    "verification_challenges",
    "tickets",
    "tags",
  ]) {
    expect(names).toContain(table);
  }
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
