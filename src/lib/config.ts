import { ChannelType } from "discord.js";
import { type BotDatabase, many, one } from "../db/index";
import { GUARD_ACTIONS } from "./guards";

// ── Config keys (snake_case column values) ──────────────────────────────────
export const CONFIG_KEYS = {
  modLogChannelId: "mod_log_channel_id",
  memberLogChannelId: "member_log_channel_id",
  dmOnAction: "dm_on_action",
  automodSpam: "automod_spam",
  automodInvites: "automod_invites",
  automodLinks: "automod_links",
  automodMentionLimit: "automod_mention_limit",
  automodSpamWindowSeconds: "automod_spam_window_seconds",
  automodSpamMaxMessages: "automod_spam_max_messages",
  autoEscalation: "auto_escalation",
  strikeDecayDays: "strike_decay_days",
  escalationTimeoutShortScore: "escalation_timeout_short_score",
  escalationTimeoutLongScore: "escalation_timeout_long_score",
  escalationKickScore: "escalation_kick_score",
  escalationBanScore: "escalation_ban_score",
  escalationTimeoutShortMinutes: "escalation_timeout_short_minutes",
  escalationTimeoutLongMinutes: "escalation_timeout_long_minutes",
  strikeWeightNote: "strike_weight_note",
  strikeWeightWarn: "strike_weight_warn",
  strikeWeightTimeout: "strike_weight_timeout",
  strikeWeightKick: "strike_weight_kick",
  minAccountAgeDays: "min_account_age_days",
  accountAgeGateAction: "account_age_gate_action",
  nameBlocklist: "name_blocklist",
  nameGuardAction: "name_guard_action",
  flagNoAvatar: "flag_no_avatar",
  guardDmOnRemoval: "guard_dm_on_removal",
  verifiedRoleId: "verified_role_id",
  verificationChannelId: "verification_channel_id",
  verificationChallengeMinutes: "verification_challenge_minutes",
  verificationCodeLength: "verification_code_length",
  verificationPanelText: "verification_panel_text",
  verificationDmOnJoin: "verification_dm_on_join",
  verificationMaxAttempts: "verification_max_attempts",
  verificationDifficulty: "verification_difficulty",
  verificationFlagYoungDays: "verification_flag_young_days",
  ticketCategoryId: "ticket_category_id",
  ticketStaffRoleId: "ticket_staff_role_id",
  ticketPanelText: "ticket_panel_text",
  ticketMaxOpenPerUser: "ticket_max_open_per_user",
  ticketInactivityHours: "ticket_inactivity_hours",
  ticketDmTranscript: "ticket_dm_transcript",
  ticketArchiveImages: "ticket_archive_images",
  ticketCloseConfirm: "ticket_close_confirm",
  ticketStaffOnlyClose: "ticket_staff_only_close",
  logMessageEvents: "log_message_events",
  logMemberEvents: "log_member_events",
  logModActions: "log_mod_actions",
  logServerEvents: "log_server_events",
} as const;

// ── Registry: the single source of truth for every setting ──────────────────
export type SettingType = "bool" | "int" | "text" | "channel" | "role" | "choice";

export interface Setting {
  key: string;
  category: string;
  type: SettingType;
  label: string;
  description?: string;
  default: unknown;
  min?: number;
  max?: number;
  channelTypes?: ChannelType[];
  choices?: { value: string; label: string }[]; // for type "choice"
}

export interface Category {
  id: string;
  label: string;
  accentColor: number;
}

export const CATEGORIES: Category[] = [
  { id: "general", label: "General", accentColor: 0x5865f2 },
  { id: "logging", label: "Logging", accentColor: 0x1abc9c },
  { id: "automod", label: "Automod", accentColor: 0xe74c3c },
  { id: "escalation", label: "Escalation", accentColor: 0xe67e22 },
  { id: "strike-weights", label: "Strike Weights", accentColor: 0xf1c40f },
  { id: "guards", label: "Guards", accentColor: 0x9b59b6 },
  { id: "verification", label: "Verification", accentColor: 0x2ecc71 },
  { id: "tickets", label: "Tickets", accentColor: 0x3498db },
];

const K = CONFIG_KEYS;
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60; // Discord's 28-day timeout cap, in minutes

export const REGISTRY: Setting[] = [
  // General
  { key: K.dmOnAction, category: "general", type: "bool", default: false, label: "DM users when actioned", description: "Send a DM to users when they are warned/kicked/banned." },
  // Logging
  { key: K.modLogChannelId, category: "logging", type: "channel", channelTypes: [ChannelType.GuildText], default: undefined, label: "Mod log channel", description: "Moderation cases, alerts, and attributed manual bans/kicks/timeouts." },
  { key: K.memberLogChannelId, category: "logging", type: "channel", channelTypes: [ChannelType.GuildText], default: undefined, label: "Member log channel", description: "Joins/leaves, nickname/role changes, message edits/deletes, channel/role changes." },
  { key: K.logMessageEvents, category: "logging", type: "bool", default: true, label: "Log message edits/deletes", description: "Edited, deleted, and bulk-deleted messages (member log)." },
  { key: K.logMemberEvents, category: "logging", type: "bool", default: true, label: "Log member events", description: "Joins, leaves, nickname changes, and role grants/removes (member log)." },
  { key: K.logModActions, category: "logging", type: "bool", default: true, label: "Log manual mod actions", description: "Bans/unbans/kicks/timeouts done outside the bot, with who and why (mod log)." },
  { key: K.logServerEvents, category: "logging", type: "bool", default: false, label: "Log server structure changes", description: "Channel and role create/delete/edit, with who (member log). Off by default — chatty." },
  // Automod
  { key: K.automodSpam, category: "automod", type: "bool", default: false, label: "Spam / flood filter" },
  { key: K.automodInvites, category: "automod", type: "bool", default: false, label: "Block invite links" },
  { key: K.automodLinks, category: "automod", type: "bool", default: false, label: "Block links" },
  { key: K.automodMentionLimit, category: "automod", type: "int", min: 1, max: 50, default: 5, label: "Max mentions per message" },
  { key: K.automodSpamWindowSeconds, category: "automod", type: "int", min: 1, max: 60, default: 7, label: "Spam window (seconds)" },
  { key: K.automodSpamMaxMessages, category: "automod", type: "int", min: 2, max: 30, default: 5, label: "Messages before flood" },
  // Escalation
  { key: K.autoEscalation, category: "escalation", type: "bool", default: false, label: "Auto-escalation enabled" },
  { key: K.strikeDecayDays, category: "escalation", type: "int", min: 1, max: 3650, default: 90, label: "Strike decay (days)" },
  { key: K.escalationTimeoutShortScore, category: "escalation", type: "int", min: 1, max: 1000, default: 3, label: "Score → short timeout" },
  { key: K.escalationTimeoutLongScore, category: "escalation", type: "int", min: 1, max: 1000, default: 5, label: "Score → long timeout" },
  { key: K.escalationKickScore, category: "escalation", type: "int", min: 1, max: 1000, default: 8, label: "Score → kick" },
  { key: K.escalationBanScore, category: "escalation", type: "int", min: 1, max: 1000, default: 12, label: "Score → ban" },
  { key: K.escalationTimeoutShortMinutes, category: "escalation", type: "int", min: 1, max: MAX_TIMEOUT_MINUTES, default: 60, label: "Short timeout (minutes)" },
  { key: K.escalationTimeoutLongMinutes, category: "escalation", type: "int", min: 1, max: MAX_TIMEOUT_MINUTES, default: 1440, label: "Long timeout (minutes)" },
  // Strike weights
  { key: K.strikeWeightNote, category: "strike-weights", type: "int", min: 0, max: 100, default: 0, label: "Weight: note" },
  { key: K.strikeWeightWarn, category: "strike-weights", type: "int", min: 0, max: 100, default: 1, label: "Weight: warn" },
  { key: K.strikeWeightTimeout, category: "strike-weights", type: "int", min: 0, max: 100, default: 2, label: "Weight: timeout" },
  { key: K.strikeWeightKick, category: "strike-weights", type: "int", min: 0, max: 100, default: 3, label: "Weight: kick" },
  // Guards
  { key: K.minAccountAgeDays, category: "guards", type: "int", min: 0, max: 3650, default: 0, label: "Min account age (days, 0=off)" },
  { key: K.accountAgeGateAction, category: "guards", type: "choice", choices: GUARD_ACTIONS, default: "flag", label: "Age gate: action", description: "What to do with an account younger than the minimum. Defaults to flag — pick kick/ban to auto-remove." },
  { key: K.nameBlocklist, category: "guards", type: "text", default: "", label: "Name blocklist", description: "Comma/newline-separated banned name patterns. Wrap in /slashes/ for regex; otherwise a case-insensitive substring." },
  { key: K.nameGuardAction, category: "guards", type: "choice", choices: GUARD_ACTIONS, default: "off", label: "Name guard: action", description: "What to do when a username/nickname matches the blocklist." },
  { key: K.flagNoAvatar, category: "guards", type: "bool", default: false, label: "Flag no-avatar joins", description: "Alert the mod-log when a joiner has the default avatar (a common bot tell)." },
  { key: K.guardDmOnRemoval, category: "guards", type: "bool", default: false, label: "DM removed users why", description: "Tell a kicked/banned joiner why (e.g. account too new), so a legit one can come back." },
  // Verification
  { key: K.verifiedRoleId, category: "verification", type: "role", default: undefined, label: "Verified role" },
  { key: K.verificationChannelId, category: "verification", type: "channel", channelTypes: [ChannelType.GuildText], default: undefined, label: "Verify channel (kept clear)" },
  { key: K.verificationChallengeMinutes, category: "verification", type: "int", min: 1, max: 60, default: 10, label: "Captcha TTL (minutes)" },
  { key: K.verificationCodeLength, category: "verification", type: "int", min: 4, max: 8, default: 6, label: "Captcha length" },
  { key: K.verificationPanelText, category: "verification", type: "text", default: "Click **Verify** to prove you're human and unlock the server.", label: "Verify panel text" },
  { key: K.verificationDmOnJoin, category: "verification", type: "bool", default: true, label: "DM captcha on join" },
  { key: K.verificationMaxAttempts, category: "verification", type: "int", min: 1, max: 10, default: 4, label: "Max captcha attempts" },
  { key: K.verificationDifficulty, category: "verification", type: "int", min: 1, max: 5, default: 3, label: "Captcha difficulty (1-5)" },
  { key: K.verificationFlagYoungDays, category: "verification", type: "int", min: 0, max: 3650, default: 7, label: "Flag verifiers younger than (days, 0=off)" },
  // Tickets
  { key: K.ticketCategoryId, category: "tickets", type: "channel", channelTypes: [ChannelType.GuildCategory], default: undefined, label: "Ticket category" },
  { key: K.ticketStaffRoleId, category: "tickets", type: "role", default: undefined, label: "Ticket staff role" },
  { key: K.ticketPanelText, category: "tickets", type: "text", default: "Need help? Click **Open Ticket** to talk to the team privately.", label: "Ticket panel text" },
  { key: K.ticketMaxOpenPerUser, category: "tickets", type: "int", min: 1, max: 10, default: 2, label: "Max open tickets per user" },
  { key: K.ticketInactivityHours, category: "tickets", type: "int", min: 0, max: 720, default: 0, label: "Auto-close after inactive hours (0=off)" },
  { key: K.ticketDmTranscript, category: "tickets", type: "bool", default: true, label: "DM the transcript to the opener on close" },
  { key: K.ticketArchiveImages, category: "tickets", type: "bool", default: true, label: "Include posted images in the archive (.zip)" },
  { key: K.ticketCloseConfirm, category: "tickets", type: "bool", default: true, label: "Confirm before closing (Close button)" },
  { key: K.ticketStaffOnlyClose, category: "tickets", type: "bool", default: false, label: "Only staff can close tickets (not the opener)" },
];

export const REGISTRY_BY_KEY: Map<string, Setting> = new Map(REGISTRY.map((s) => [s.key, s]));

export function getSetting(key: string): Setting | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export function settingsByCategory(categoryId: string): Setting[] {
  return REGISTRY.filter((s) => s.category === categoryId);
}

// Validate a typed value against a setting's type + bounds (used by import + modal).
export function validateSetting(setting: Setting, value: unknown): boolean {
  switch (setting.type) {
    case "bool":
      return typeof value === "boolean";
    case "int":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        (setting.min === undefined || value >= setting.min) &&
        (setting.max === undefined || value <= setting.max)
      );
    case "text":
      return typeof value === "string";
    case "channel":
    case "role":
      return typeof value === "string" && /^\d{17,20}$/.test(value);
    case "choice":
      return typeof value === "string" && (setting.choices?.some((c) => c.value === value) ?? false);
  }
}

// ── Guild-scoped settings, stored JSON-encoded in guild_config ──────────────
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

  // Stored value, falling back to the registry default. Use for settings with a
  // meaningful default (bools/ints/text); use get() for unset-sensitive keys.
  getEffective<T>(guildId: string, key: string): T {
    const stored = this.get<T>(guildId, key);
    return stored ?? (REGISTRY_BY_KEY.get(key)?.default as T);
  }

  set(guildId: string, key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO guild_config (guild_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(guildId, key, JSON.stringify(value), Date.now());
  }

  unset(guildId: string, key: string): void {
    this.db.query("DELETE FROM guild_config WHERE guild_id = ? AND key = ?").run(guildId, key);
  }

  // Revert every setting for a guild to its registry default (delete all rows).
  reset(guildId: string): number {
    return this.db.query("DELETE FROM guild_config WHERE guild_id = ?").run(guildId).changes;
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
