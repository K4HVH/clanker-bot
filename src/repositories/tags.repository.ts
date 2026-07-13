import { and, asc, eq } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { tags } from "../db/schema";

export function setTag(db: BotDatabase, guildId: string, name: string, content: string): void {
  db.insert(tags)
    .values({ guildId, name, content, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [tags.guildId, tags.name],
      set: { content, updatedAt: Date.now() },
    })
    .run();
}

export function getTag(db: BotDatabase, guildId: string, name: string): string | undefined {
  return db
    .select({ content: tags.content })
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
    .get()?.content;
}

export function deleteTag(db: BotDatabase, guildId: string, name: string): void {
  db.delete(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
    .run();
}

export function listTags(db: BotDatabase, guildId: string): string[] {
  return db
    .select({ name: tags.name })
    .from(tags)
    .where(eq(tags.guildId, guildId))
    .orderBy(asc(tags.name))
    .all()
    .map((r) => r.name);
}
