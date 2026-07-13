import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDatabase, runMigrations } from "../../src/db/client";
import { guildConfig } from "../../src/db/schema";

test("migrations create guild_config and rows round-trip", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  db.insert(guildConfig)
    .values({ guildId: "g1", key: "mod_log_channel_id", value: '"123"', updatedAt: 1 })
    .run();

  const rows = db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.guildId, "g1"), eq(guildConfig.key, "mod_log_channel_id")))
    .all();

  expect(rows.length).toBe(1);
  expect(rows[0]?.value).toBe('"123"');
});
