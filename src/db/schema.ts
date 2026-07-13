import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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

// Durable queue of future actions (e.g. expire a temp-ban).
export const scheduledActions = sqliteTable(
  "scheduled_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    type: text("type").notNull(),
    userId: text("user_id").notNull(),
    reason: text("reason"),
    runAt: integer("run_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("scheduled_actions_run_at_idx").on(t.runAt)],
);

// Pending captcha challenges (one active per user per guild).
export const verificationChallenges = sqliteTable(
  "verification_challenges",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    code: text("code").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);

// Support tickets (one private channel each).
export const tickets = sqliteTable(
  "tickets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    ticketNumber: integer("ticket_number").notNull(),
    channelId: text("channel_id").notNull(),
    openerId: text("opener_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    transcript: text("transcript"),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [uniqueIndex("tickets_channel_idx").on(t.channelId)],
);
