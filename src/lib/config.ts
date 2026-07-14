import { type BotDatabase, many, one, run } from "../db/index";

export const CONFIG_KEYS = {
  modLogChannelId: "mod_log_channel_id",
  memberLogChannelId: "member_log_channel_id",
  dmOnAction: "dm_on_action",
  strikeDecayDays: "strike_decay_days",
  automodSpam: "automod_spam",
  automodInvites: "automod_invites",
  automodLinks: "automod_links",
  autoEscalation: "auto_escalation",
  verifiedRoleId: "verified_role_id",
  minAccountAgeDays: "min_account_age_days",
  raidDetection: "raid_detection",
  ticketCategoryId: "ticket_category_id",
  ticketStaffRoleId: "ticket_staff_role_id",
  welcomeChannelId: "welcome_channel_id",
  welcomeMessage: "welcome_message",
} as const;

// Guild-scoped settings, stored JSON-encoded in the guild_config table.
export class ConfigService {
  constructor(private readonly db: BotDatabase) {}

  get<T>(guildId: string, key: string): T | undefined {
    const row = one<{ value: string }>(
      this.db,
      "SELECT value FROM guild_config WHERE guild_id = ? AND key = ?",
      guildId,
      key,
    );
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  set(guildId: string, key: string, value: unknown): void {
    run(
      this.db,
      `INSERT INTO guild_config (guild_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      guildId,
      key,
      JSON.stringify(value),
      Date.now(),
    );
  }

  unset(guildId: string, key: string): void {
    run(this.db, "DELETE FROM guild_config WHERE guild_id = ? AND key = ?", guildId, key);
  }

  all(guildId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of many<{ key: string; value: string }>(
      this.db,
      "SELECT key, value FROM guild_config WHERE guild_id = ?",
      guildId,
    )) {
      out[row.key] = JSON.parse(row.value);
    }
    return out;
  }
}
