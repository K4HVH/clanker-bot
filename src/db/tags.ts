import { type BotDatabase, many, one, run } from "../db/index";

export function setTag(db: BotDatabase, guildId: string, name: string, content: string): void {
  run(
    db,
    `INSERT INTO tags (guild_id, name, content, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    guildId,
    name,
    content,
    Date.now(),
  );
}

export function getTag(db: BotDatabase, guildId: string, name: string): string | undefined {
  return one<{ content: string }>(
    db,
    "SELECT content FROM tags WHERE guild_id = ? AND name = ?",
    guildId,
    name,
  )?.content;
}

export function deleteTag(db: BotDatabase, guildId: string, name: string): void {
  run(db, "DELETE FROM tags WHERE guild_id = ? AND name = ?", guildId, name);
}

export function listTags(db: BotDatabase, guildId: string): string[] {
  return many<{ name: string }>(
    db,
    "SELECT name FROM tags WHERE guild_id = ? ORDER BY name ASC",
    guildId,
  ).map((r) => r.name);
}
