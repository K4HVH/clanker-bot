import type { BotDatabase } from "../db/client";
import {
  deleteConfigRow,
  getConfigRow,
  listConfigRows,
  setConfigRow,
} from "../repositories/config.repository";

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
} as const;

export class ConfigService {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly db: BotDatabase) {}

  private cacheKey(guildId: string, key: string): string {
    return `${guildId}:${key}`;
  }

  get<T>(guildId: string, key: string): T | undefined {
    const ck = this.cacheKey(guildId, key);
    if (this.cache.has(ck)) return this.cache.get(ck) as T | undefined;
    const raw = getConfigRow(this.db, guildId, key);
    const value = raw === undefined ? undefined : (JSON.parse(raw) as T);
    this.cache.set(ck, value);
    return value;
  }

  set(guildId: string, key: string, value: unknown): void {
    setConfigRow(this.db, guildId, key, JSON.stringify(value), Date.now());
    this.cache.set(this.cacheKey(guildId, key), value);
  }

  unset(guildId: string, key: string): void {
    deleteConfigRow(this.db, guildId, key);
    this.cache.set(this.cacheKey(guildId, key), undefined);
  }

  all(guildId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of listConfigRows(this.db, guildId)) out[row.key] = JSON.parse(row.value);
    return out;
  }
}
