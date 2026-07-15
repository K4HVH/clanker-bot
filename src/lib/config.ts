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
  placeholder?: string; // example text shown in the edit modal for int/text
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
  { id: "guards", label: "Guards", accentColor: 0x9b59b6 },
  { id: "verification", label: "Verification", accentColor: 0x2ecc71 },
  { id: "tickets", label: "Tickets", accentColor: 0x3498db },
];

const K = CONFIG_KEYS;

export const REGISTRY: Setting[] = [
  // General
  { key: K.dmOnAction, category: "general", type: "bool", default: false, label: "DM users when actioned", description: "Send a DM to users when they are warned/kicked/banned." },
  // Logging
  { key: K.modLogChannelId, category: "logging", type: "channel", channelTypes: [ChannelType.GuildText], default: undefined, label: "Mod log channel", description: "Moderation actions, alerts, and attributed manual bans/kicks/timeouts." },
  { key: K.memberLogChannelId, category: "logging", type: "channel", channelTypes: [ChannelType.GuildText], default: undefined, label: "Member log channel", description: "Joins/leaves, nickname/role changes, message edits/deletes, channel/role changes." },
  { key: K.logMessageEvents, category: "logging", type: "bool", default: true, label: "Log message edits/deletes", description: "Edited, deleted, and bulk-deleted messages (member log)." },
  { key: K.logMemberEvents, category: "logging", type: "bool", default: true, label: "Log member events", description: "Joins, leaves, nickname changes, and role grants/removes (member log)." },
  { key: K.logModActions, category: "logging", type: "bool", default: true, label: "Log manual mod actions", description: "Bans/unbans/kicks/timeouts done outside the bot, with who and why (mod log)." },
  { key: K.logServerEvents, category: "logging", type: "bool", default: false, label: "Log server structure changes", description: "Channel and role create/delete/edit, with who (member log). Off by default — chatty." },
  // Automod
  { key: K.automodSpam, category: "automod", type: "bool", default: false, label: "Spam / flood filter", description: "Delete rapid message floods (per the window/count below) and warn the sender." },
  { key: K.automodInvites, category: "automod", type: "bool", default: false, label: "Block invite links", description: "Delete messages containing Discord invite links and warn the sender." },
  { key: K.automodLinks, category: "automod", type: "bool", default: false, label: "Block links", description: "Delete messages containing any URL and warn the sender." },
  { key: K.automodMentionLimit, category: "automod", type: "int", min: 1, max: 50, default: 5, label: "Max mentions per message", description: "Delete a message that mentions more than this many users/roles combined." },
  { key: K.automodSpamWindowSeconds, category: "automod", type: "int", min: 1, max: 60, default: 7, label: "Spam window (seconds)", description: "The sliding time window used to detect a message flood." },
  { key: K.automodSpamMaxMessages, category: "automod", type: "int", min: 2, max: 30, default: 5, label: "Messages before flood", description: "How many messages within the window count as a flood." },
  // Guards
  { key: K.minAccountAgeDays, category: "guards", type: "int", min: 0, max: 3650, default: 0, label: "Min account age (days, 0=off)", description: "Accounts newer than this trip the age gate. 0 disables it." },
  { key: K.accountAgeGateAction, category: "guards", type: "choice", choices: GUARD_ACTIONS, default: "flag", label: "Age gate: action", description: "What to do with an account younger than the minimum. Defaults to flag — pick kick/ban to auto-remove." },
  { key: K.nameBlocklist, category: "guards", type: "text", default: "", label: "Name blocklist", description: "Banned name patterns, ONE PER LINE. A line is either a word (matched anywhere in the name, case-insensitive, 3+ chars) or a /regex/. Commas also separate words on a line. Only acts when 'Name guard: action' is above Off.", placeholder: "scam, free nitro\n/^(mod|admin|staff)$/" },
  { key: K.nameGuardAction, category: "guards", type: "choice", choices: GUARD_ACTIONS, default: "off", label: "Name guard: action", description: "What to do when a username/nickname matches the blocklist." },
  { key: K.flagNoAvatar, category: "guards", type: "bool", default: false, label: "Flag no-avatar joins", description: "Alert the mod-log when a joiner has the default avatar (a common bot tell)." },
  { key: K.guardDmOnRemoval, category: "guards", type: "bool", default: false, label: "DM removed users why", description: "Tell a kicked/banned joiner why (e.g. account too new), so a legit one can come back." },
  // Verification
  { key: K.verifiedRoleId, category: "verification", type: "role", default: undefined, label: "Verified role", description: "Role granted once a member passes verification — gate your channels behind it. Required for verification to work." },
  { key: K.verificationChannelId, category: "verification", type: "channel", channelTypes: [ChannelType.GuildText], default: undefined, label: "Verify channel (kept clear)", description: "Optional channel the bot auto-scrubs (deletes every non-staff message) so members can type their code in it." },
  { key: K.verificationChallengeMinutes, category: "verification", type: "int", min: 1, max: 60, default: 10, label: "Captcha TTL (minutes)", description: "How long a captcha code stays valid before it expires." },
  { key: K.verificationCodeLength, category: "verification", type: "int", min: 4, max: 8, default: 6, label: "Captcha length", description: "Number of characters in the captcha code." },
  { key: K.verificationPanelText, category: "verification", type: "text", default: "Click **Verify** to prove you're human and unlock the server.", label: "Verify panel text", description: "Message shown on the /verify panel above the Verify button." },
  { key: K.verificationDmOnJoin, category: "verification", type: "bool", default: true, label: "DM captcha on join", description: "DM a new member their captcha as soon as they join." },
  { key: K.verificationMaxAttempts, category: "verification", type: "int", min: 1, max: 10, default: 4, label: "Max captcha attempts", description: "Wrong tries allowed before the captcha is voided (shared across DM + channel)." },
  { key: K.verificationDifficulty, category: "verification", type: "int", min: 1, max: 5, default: 3, label: "Captcha difficulty (1-5)", description: "Distortion level — higher is harder for bots (and for humans)." },
  { key: K.verificationFlagYoungDays, category: "verification", type: "int", min: 0, max: 3650, default: 7, label: "Flag verifiers younger than (days, 0=off)", description: "Alert the mod-log when an account younger than this passes verification. 0 = off." },
  // Tickets
  { key: K.ticketCategoryId, category: "tickets", type: "channel", channelTypes: [ChannelType.GuildCategory], default: undefined, label: "Ticket category", description: "Category that new ticket channels are created under." },
  { key: K.ticketStaffRoleId, category: "tickets", type: "role", default: undefined, label: "Ticket staff role", description: "Role given access to every ticket and pinged when one opens." },
  { key: K.ticketPanelText, category: "tickets", type: "text", default: "Need help? Click **Open Ticket** to talk to the team privately.", label: "Ticket panel text", description: "Message shown on the /ticket panel above the Open Ticket button." },
  { key: K.ticketMaxOpenPerUser, category: "tickets", type: "int", min: 1, max: 10, default: 2, label: "Max open tickets per user", description: "How many tickets one member may have open at once." },
  { key: K.ticketInactivityHours, category: "tickets", type: "int", min: 0, max: 720, default: 0, label: "Auto-close after inactive hours (0=off)", description: "Auto-close a ticket after this many hours with no messages (warns first). 0 = never." },
  { key: K.ticketDmTranscript, category: "tickets", type: "bool", default: true, label: "DM the transcript to the opener on close", description: "DM the transcript to the ticket opener when it closes." },
  { key: K.ticketArchiveImages, category: "tickets", type: "bool", default: true, label: "Include posted images in the archive (.zip)", description: "Bundle posted images with the transcript as a .zip on close." },
  { key: K.ticketCloseConfirm, category: "tickets", type: "bool", default: true, label: "Confirm before closing (Close button)", description: "Ask for confirmation before the Close button closes a ticket." },
  { key: K.ticketStaffOnlyClose, category: "tickets", type: "bool", default: false, label: "Only staff can close tickets (not the opener)", description: "When on, the opener can't close their own ticket — only staff can." },
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
