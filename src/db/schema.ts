import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

// Moderation case ledger. `case_number` is a per-guild sequential counter.
export const cases = sqliteTable(
  "cases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    caseNumber: integer("case_number").notNull(),
    userId: text("user_id").notNull(),
    moderatorId: text("moderator_id").notNull(),
    type: text("type").notNull(),
    reason: text("reason").notNull(),
    meta: text("meta"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("cases_guild_case_idx").on(t.guildId, t.caseNumber)],
);
