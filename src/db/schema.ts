import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Guild-scoped key/value config. `value` holds JSON-encoded data.
export const guildConfig = sqliteTable(
  "guild_config",
  {
    guildId: text("guild_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.key] })],
);
