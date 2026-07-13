import { and, eq } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { guildConfig } from "../db/schema";

export function getConfigRow(db: BotDatabase, guildId: string, key: string): string | undefined {
  const row = db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.guildId, guildId), eq(guildConfig.key, key)))
    .get();
  return row?.value;
}

export function setConfigRow(
  db: BotDatabase,
  guildId: string,
  key: string,
  value: string,
  updatedAt: number,
): void {
  db.insert(guildConfig)
    .values({ guildId, key, value, updatedAt })
    .onConflictDoUpdate({
      target: [guildConfig.guildId, guildConfig.key],
      set: { value, updatedAt },
    })
    .run();
}

export function listConfigRows(db: BotDatabase, guildId: string): { key: string; value: string }[] {
  return db
    .select({ key: guildConfig.key, value: guildConfig.value })
    .from(guildConfig)
    .where(eq(guildConfig.guildId, guildId))
    .all();
}

export function deleteConfigRow(db: BotDatabase, guildId: string, key: string): void {
  db.delete(guildConfig)
    .where(and(eq(guildConfig.guildId, guildId), eq(guildConfig.key, key)))
    .run();
}
