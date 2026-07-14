import { type BotDatabase, many, one, run } from "../db/index";

export function getConfigRow(db: BotDatabase, guildId: string, key: string): string | undefined {
  return one<{ value: string }>(
    db,
    "SELECT value FROM guild_config WHERE guild_id = ? AND key = ?",
    guildId,
    key,
  )?.value;
}

export function setConfigRow(
  db: BotDatabase,
  guildId: string,
  key: string,
  value: string,
  updatedAt: number,
): void {
  run(
    db,
    `INSERT INTO guild_config (guild_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    guildId,
    key,
    value,
    updatedAt,
  );
}

export function listConfigRows(
  db: BotDatabase,
  guildId: string,
): { key: string; value: string }[] {
  return many<{ key: string; value: string }>(
    db,
    "SELECT key, value FROM guild_config WHERE guild_id = ?",
    guildId,
  );
}

export function deleteConfigRow(db: BotDatabase, guildId: string, key: string): void {
  run(db, "DELETE FROM guild_config WHERE guild_id = ? AND key = ?", guildId, key);
}
