import { ChannelType } from "discord.js";
import { GUARD_ACTIONS, SCAM_ACTIONS } from "./actions";
import { type BotDatabase, many, one } from "../db/index";

// Channel types a text-message picker should offer. A mod-log or trap channel can be an
// announcement or voice channel as well as a plain text one; restricting to text is why such
// channels do not show in the picker.
const TEXT_CHANNELS: ChannelType[] = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
];

// ── Config keys (snake_case column values) ──────────────────────────────────
export const CONFIG_KEYS = {
  modLogChannelId: "mod_log_channel_id",
  memberLogChannelId: "member_log_channel_id",
  dmOnAction: "dm_on_action",
  autoWipeHours: "auto_wipe_hours",
  timeoutMinutes: "timeout_minutes",
  automodModerateTickets: "automod_moderate_tickets",
  automodInvites: "automod_invites",
  automodLinks: "automod_links",
  automodLinkAllowlist: "automod_link_allowlist",
  automodWordBlocklist: "automod_word_blocklist",
  automodMentionLimit: "automod_mention_limit",
  automodMassMention: "automod_mass_mention",
  automodCaps: "automod_caps",
  automodDuplicates: "automod_duplicates",
  automodFlood: "automod_flood",
  automodFloodMessages: "automod_flood_messages",
  automodFloodSeconds: "automod_flood_seconds",
  automodViolationTtlMinutes: "automod_violation_ttl_minutes",
  automodTimeoutAt: "automod_timeout_at",
  automodKickAt: "automod_kick_at",
  automodBanAt: "automod_ban_at",
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
  memesEnabled: "memes_enabled",
  memesSuccessReplies: "memes_success_replies",
  memesDeniedReplies: "memes_denied_replies",
  memesBlockedReplies: "memes_blocked_replies",
  // Honeypot: a bait channel no legitimate member should post in.
  honeypotChannelId: "honeypot_channel_id",
  honeypotAction: "honeypot_action",
  honeypotPanelText: "honeypot_panel_text",
  honeypotExemptRoles: "honeypot_exempt_roles",
  honeypotDmUser: "honeypot_dm_user",
  honeypotAlertRoleId: "honeypot_alert_role_id",
  // Automod Scam. Confirmed-bad detections enforced by automod, fed by the seeding subsystem.
  scamSignatureAction: "scam_signature_action",
  scamSprayAction: "scam_spray_action",
  scamSprayChannels: "scam_spray_channels",
  scamSpraySeconds: "scam_spray_seconds",
  scamSpraySimilarity: "scam_spray_similarity",
  scamSprayMinChars: "scam_spray_min_chars",
  scamSprayMatchAttachments: "scam_spray_match_attachments",
  scamSprayExemptStaff: "scam_spray_exempt_staff",
  scamSeedFromHoneypot: "scam_seed_from_honeypot",
  scamSeedDomains: "scam_seed_domains",
  scamSeedImages: "scam_seed_images",
  scamMaxImageMb: "scam_max_image_mb",
  scamSeedTtlDays: "scam_seed_ttl_days",
  scamSeedMaxEntries: "scam_seed_max_entries",
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
  { id: "moderation", label: "Moderation", accentColor: 0x5865f2 },
  { id: "logging", label: "Logging", accentColor: 0x1abc9c },
  // All the Automod pages sit together, in enforcement order.
  { id: "automod", label: "Automod", accentColor: 0xe74c3c },
  { id: "automod-actions", label: "Automod Actions", accentColor: 0xc0392b },
  { id: "automod-scam", label: "Automod Scam", accentColor: 0xd35400 },
  { id: "automod-scam-seed", label: "Automod Scam Seeding", accentColor: 0xd35400 },
  { id: "guards", label: "Guards", accentColor: 0x9b59b6 },
  { id: "verification", label: "Verification", accentColor: 0x2ecc71 },
  { id: "tickets", label: "Tickets", accentColor: 0x3498db },
  { id: "memes", label: "Memes", accentColor: 0xe67e22 },
  { id: "honeypot", label: "Honeypot", accentColor: 0xf1c40f },
];

const K = CONFIG_KEYS;

export const REGISTRY: Setting[] = [
  // Moderation. The shared punishment magnitudes live here (one each), read by every feature.
  { key: K.dmOnAction, category: "moderation", type: "bool", default: false, label: "DM users when actioned", description: "Send a DM to users when they are warned/timed out/kicked/banned, telling them the reason." },
  { key: K.autoWipeHours, category: "moderation", type: "int", min: 0, max: 168, default: 24, label: "Auto-wipe: last N hours of messages", description: "When the bot kicks or bans someone automatically (guards, automod, honeypot, scam), delete this many hours of their messages (max 168). Bans use Discord's native wipe; kicks purge recent messages. 0 keeps them." },
  { key: K.timeoutMinutes, category: "moderation", type: "int", min: 1, max: 40320, default: 10, label: "Auto-timeout: length (minutes)", description: "How long any automatic timeout lasts: the automod ladder, a scam signature match, and a spray. Max 28 days." },
  // Logging
  { key: K.modLogChannelId, category: "logging", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "Mod log channel", description: "Moderation actions, alerts, and attributed manual bans/kicks/timeouts." },
  { key: K.memberLogChannelId, category: "logging", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "Member log channel", description: "Joins/leaves, nickname/role changes, message edits/deletes, channel/role changes." },
  { key: K.logMessageEvents, category: "logging", type: "bool", default: true, label: "Log message edits/deletes", description: "Edited, deleted, and bulk-deleted messages (member log)." },
  { key: K.logMemberEvents, category: "logging", type: "bool", default: true, label: "Log member events", description: "Joins, leaves, nickname changes, and role grants/removes (member log)." },
  { key: K.logModActions, category: "logging", type: "bool", default: true, label: "Log manual mod actions", description: "Bans/unbans/kicks/timeouts done outside the bot, with who and why (mod log)." },
  { key: K.logServerEvents, category: "logging", type: "bool", default: false, label: "Log server structure changes", description: "Channel and role create/delete/edit, with who (member log). Off by default (chatty)." },
  // Automod: content filters (each fires a "violation": delete + record; see Automod Actions
  // for what accumulated violations do). All off by default; re-checked on message edits too.
  { key: K.automodModerateTickets, category: "automod", type: "bool", default: false, label: "Also moderate ticket channels", description: "By default automod ignores ticket channels (private support). Turn on to enforce there too." },
  { key: K.automodInvites, category: "automod", type: "bool", default: false, label: "Block invite links", description: "Delete messages with a Discord invite (discord.gg, discord.com/invite, discord.new, dsc.gg)." },
  { key: K.automodLinks, category: "automod", type: "bool", default: false, label: "Block links", description: "Delete messages with a URL whose domain isn't in the allowlist below." },
  { key: K.automodLinkAllowlist, category: "automod", type: "text", default: "", label: "Link allowlist", description: "Domains that are always allowed, comma/newline separated (e.g. github.com, youtube.com). Subdomains match. Empty = block every link.", placeholder: "github.com, youtube.com\ndocs.espressif.com" },
  { key: K.automodWordBlocklist, category: "automod", type: "text", default: "", label: "Word blocklist", description: "Banned words/phrases, one per line: a word (case-insensitive substring, 3+ chars) or a /regex/. Commas also separate words on a line.", placeholder: "slur1, slur2\n/free ?nitro/" },
  { key: K.automodMentionLimit, category: "automod", type: "int", min: 0, max: 50, default: 0, label: "Max mentions per message (0=off)", description: "Delete a message mentioning more than this many users/roles combined. 0 disables." },
  { key: K.automodMassMention, category: "automod", type: "bool", default: false, label: "Block @everyone / @here", description: "Delete a message that pings @everyone or @here (from a non-staff member)." },
  { key: K.automodCaps, category: "automod", type: "bool", default: false, label: "Block excessive caps", description: "Delete a longer message (24+ letters) that is mostly UPPERCASE." },
  { key: K.automodDuplicates, category: "automod", type: "bool", default: false, label: "Block duplicate spam", description: "Delete a message identical to one the same user just sent (within the flood window)." },
  // Automod Actions: the flood rule + what accumulated violations trigger.
  { key: K.automodFlood, category: "automod-actions", type: "bool", default: false, label: "Flood filter", description: "Treat sending too many messages too fast (below) as a violation." },
  { key: K.automodFloodMessages, category: "automod-actions", type: "int", min: 2, max: 30, default: 5, label: "Flood: messages", description: "How many messages within the window count as a flood." },
  { key: K.automodFloodSeconds, category: "automod-actions", type: "int", min: 1, max: 60, default: 7, label: "Flood: window (seconds)", description: "The sliding window for the flood + duplicate checks." },
  { key: K.automodViolationTtlMinutes, category: "automod-actions", type: "int", min: 1, max: 10080, default: 60, label: "Violation memory (minutes)", description: "How long an automod violation keeps counting toward the escalation thresholds below." },
  { key: K.automodTimeoutAt, category: "automod-actions", type: "int", min: 0, max: 100, default: 3, label: "Timeout at N violations (0=off)", description: "Timeout a user once they hit this many violations within the memory window. Length is set under Moderation." },
  { key: K.automodKickAt, category: "automod-actions", type: "int", min: 0, max: 100, default: 0, label: "Kick at N violations (0=off)", description: "Kick a user once they hit this many violations. Off by default." },
  { key: K.automodBanAt, category: "automod-actions", type: "int", min: 0, max: 100, default: 0, label: "Ban at N violations (0=off)", description: "Ban a user once they hit this many violations. Off by default." },
  // Guards
  { key: K.minAccountAgeDays, category: "guards", type: "int", min: 0, max: 3650, default: 0, label: "Min account age (days, 0=off)", description: "Accounts newer than this trip the age gate. 0 disables it." },
  { key: K.accountAgeGateAction, category: "guards", type: "choice", choices: GUARD_ACTIONS, default: "flag", label: "Age gate: action", description: "What to do with an account younger than the minimum. Defaults to flag: pick kick/ban to auto-remove." },
  { key: K.nameBlocklist, category: "guards", type: "text", default: "", label: "Name blocklist", description: "Banned name patterns, ONE PER LINE. A line is either a word (matched anywhere in the name, case-insensitive, 3+ chars) or a /regex/. Commas also separate words on a line. Only acts when 'Name guard: action' is above Off.", placeholder: "scam, free nitro\n/^(mod|admin|staff)$/" },
  { key: K.nameGuardAction, category: "guards", type: "choice", choices: GUARD_ACTIONS, default: "off", label: "Name guard: action", description: "What to do when a username/nickname matches the blocklist." },
  { key: K.flagNoAvatar, category: "guards", type: "bool", default: false, label: "Flag no-avatar joins", description: "Alert the mod-log when a joiner has the default avatar (a common bot tell)." },
  { key: K.guardDmOnRemoval, category: "guards", type: "bool", default: false, label: "DM removed users why", description: "Tell a kicked/banned joiner why (e.g. account too new), so a legit one can come back." },
  // Verification
  { key: K.verifiedRoleId, category: "verification", type: "role", default: undefined, label: "Verified role", description: "Role granted once a member passes verification. Gate your channels behind it. Required for verification to work." },
  { key: K.verificationChannelId, category: "verification", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "Verify channel (kept clear)", description: "Optional channel the bot auto-scrubs (deletes every non-staff message) so members can type their code in it." },
  { key: K.verificationChallengeMinutes, category: "verification", type: "int", min: 1, max: 60, default: 10, label: "Captcha TTL (minutes)", description: "How long a captcha code stays valid before it expires." },
  { key: K.verificationCodeLength, category: "verification", type: "int", min: 4, max: 8, default: 6, label: "Captcha length", description: "Number of characters in the captcha code." },
  { key: K.verificationPanelText, category: "verification", type: "text", default: "Click **Verify** to prove you're human and unlock the server.", label: "Verify panel text", description: "Message shown on the /verify panel above the Verify button." },
  { key: K.verificationDmOnJoin, category: "verification", type: "bool", default: true, label: "DM captcha on join", description: "DM a new member their captcha as soon as they join." },
  { key: K.verificationMaxAttempts, category: "verification", type: "int", min: 1, max: 10, default: 4, label: "Max captcha attempts", description: "Wrong tries allowed before the captcha is voided (shared across DM + channel)." },
  { key: K.verificationDifficulty, category: "verification", type: "int", min: 1, max: 5, default: 3, label: "Captcha difficulty (1-5)", description: "Distortion level: higher is harder for bots (and for humans)." },
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
  { key: K.ticketStaffOnlyClose, category: "tickets", type: "bool", default: false, label: "Only staff can close tickets (not the opener)", description: "When on, the opener can't close their own ticket. Only staff can." },
  // Memes: @-mention moderation ("@bot ban @user"). Runs the real mod pipeline for people who
  // hold the permission; snarks at those who don't. All replies pull a random line from the lists
  // (blank = built-in defaults). Placeholders: {mod}, {target}, {action}.
  { key: K.memesEnabled, category: "memes", type: "bool", default: false, label: "@-mention commands", description: "Let people @ the bot to moderate (\"@bot ban @user\"). It obeys those with the permission and snarks at those without. Off by default." },
  { key: K.memesSuccessReplies, category: "memes", type: "text", default: "", label: "Success lines", description: "Random reply when the bot carries out a command. One per line. {mod}, {target}, {action}. Blank = built-in defaults.", placeholder: "gone.\n{target} who?" },
  { key: K.memesDeniedReplies, category: "memes", type: "text", default: "", label: "Denied lines (no permission)", description: "Random snark when someone WITHOUT the permission tries it. One per line. {mod}, {target}. Blank = built-in defaults.", placeholder: "no.\nwho the fuck are you?" },
  { key: K.memesBlockedReplies, category: "memes", type: "text", default: "", label: "Can't-do-that lines", description: "Random reply when the target can't be actioned (owner, higher role, not in the server). One per line. {mod}, {target}. Blank = defaults.", placeholder: "can't, they outrank us both.\nabove my paygrade." },
  // Honeypot: a bait channel no real member should post in. Anyone who does is almost certainly a
  // compromised account or spam bot, so the action can be instant. Unset channel or "off" is inert.
  { key: K.honeypotChannelId, category: "honeypot", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "Honeypot channel", description: "Trap channel. Anyone who posts here trips the action below. Put it near the top of your channel list. Unset = disabled." },
  { key: K.honeypotAction, category: "honeypot", type: "choice", choices: GUARD_ACTIONS, default: "off", label: "Honeypot: action", description: "What to do with someone who posts in the trap channel. Defaults to off. Flag to watch, kick/ban to remove. Ban wipe and timeout length come from Moderation." },
  { key: K.honeypotPanelText, category: "honeypot", type: "text", default: "**Do not post in this channel.** It is a trap for compromised accounts. Posting here removes you from the server automatically.", label: "Honeypot panel text", description: "Message shown by /honeypot panel in the trap channel." },
  { key: K.honeypotExemptRoles, category: "honeypot", type: "text", default: "", label: "Exempt role IDs", description: "Role IDs never actioned, comma/newline separated. The owner and Manage Messages holders are always exempt.", placeholder: "1234567890, 9876543210" },
  { key: K.honeypotDmUser, category: "honeypot", type: "bool", default: true, label: "DM removed users why", description: "Tell a kicked/banned user why (sent before removal), so a hijack victim knows to secure their account." },
  { key: K.honeypotAlertRoleId, category: "honeypot", type: "role", default: undefined, label: "Alert role", description: "Role pinged in the mod-log whenever the honeypot fires. Needs a mod-log channel set under Logging. A hit can also seed the scam signature list (see Automod Scam Seeding) when seeding is on." },
  // Automod Scam. Confirmed-bad detections run inside automod's scan, before the heuristic rules.
  // A match is decisive (it acts at once, not via the violation ladder) because a seeded signature
  // or a cross-channel spray is a fact, not a guess. Timeout length and ban wipe come from Moderation.
  { key: K.scamSignatureAction, category: "automod-scam", type: "choice", choices: SCAM_ACTIONS, default: "off", label: "Scam signature: action", description: "What to do when a message matches a domain or image on the scam signature list (seeded by the honeypot or added with /mod scamseed). Off and flag watch, delete removes the message without punishing, timeout/kick/ban also penalise. Domains, embeds, filenames and image hashes are all checked." },
  { key: K.scamSprayAction, category: "automod-scam", type: "choice", choices: SCAM_ACTIONS, default: "off", label: "Spray: action", description: "What to do when one user posts near-identical content across many channels, a hijacked-account tell. Off and flag watch, delete clears the spam without punishing, timeout/kick/ban also penalise." },
  { key: K.scamSprayChannels, category: "automod-scam", type: "int", min: 2, max: 10, default: 3, label: "Spray: distinct channels to trip", description: "How many distinct channels the same content must hit within the window to count as a spray." },
  { key: K.scamSpraySeconds, category: "automod-scam", type: "int", min: 5, max: 300, default: 60, label: "Spray: window (seconds)", description: "The window for counting cross-channel posts. Independent of the automod flood window." },
  { key: K.scamSpraySimilarity, category: "automod-scam", type: "int", min: 50, max: 100, default: 85, label: "Spray: text similarity (%)", description: "How similar (percent) two messages must be to count as the same spray. Below 100 catches randomized near-duplicates." },
  { key: K.scamSprayMinChars, category: "automod-scam", type: "int", min: 0, max: 200, default: 15, label: "Spray: ignore text shorter than (chars)", description: "Ignore text shorter than this for similarity, so short messages across channels don't trip it. 0 checks all text." },
  { key: K.scamSprayMatchAttachments, category: "automod-scam", type: "bool", default: true, label: "Spray: match identical attachments", description: "Also count an identical image/file (same size and dimensions) across channels, so image-only sprays trip it too." },
  { key: K.scamSprayExemptStaff, category: "automod-scam", type: "bool", default: false, label: "Spray: exempt staff", description: "Let staff bypass spray detection. Off by default, since a compromised mod account is exactly what this should still catch." },
  // Automod Scam Seeding. The one automated writer of the signature list the rules above enforce.
  { key: K.scamSeedFromHoneypot, category: "automod-scam-seed", type: "bool", default: false, label: "Seed: from honeypot hits", description: "When the honeypot catches someone, add their domains and image hash to the signature list, so later accounts posting the same scam are caught by the match action in Automod Scam. Off by default. Enable once the honeypot runs clean." },
  { key: K.scamSeedDomains, category: "automod-scam-seed", type: "bool", default: true, label: "Seed: domains", description: "Include scam domains when seeding. Skips anything allowlisted or on shared hosting." },
  { key: K.scamSeedImages, category: "automod-scam-seed", type: "bool", default: true, label: "Seed: image hashes", description: "Include a SHA-256 of the scam image when seeding. The image itself is never stored." },
  { key: K.scamMaxImageMb, category: "automod-scam-seed", type: "int", min: 1, max: 25, default: 8, label: "Seed: max image size (MB)", description: "Images larger than this are matched by size and dimensions only, never downloaded to hash. Used by both seeding and matching." },
  { key: K.scamSeedTtlDays, category: "automod-scam-seed", type: "int", min: 1, max: 365, default: 30, label: "Seed: signature lifetime (days)", description: "Seeded signatures expire after this many days, so a wrong entry ages out on its own." },
  { key: K.scamSeedMaxEntries, category: "automod-scam-seed", type: "int", min: 50, max: 5000, default: 500, label: "Seed: max stored signatures", description: "Cap on seeded signatures per kind. The oldest are evicted past this limit." },
];

export const REGISTRY_BY_KEY: Map<string, Setting> = new Map(REGISTRY.map((s) => [s.key, s]));

// Old key -> new key, for the anti-scam-into-automod restructure. A stored value is carried over
// unless the guild already has a value under the new key.
const CONFIG_RENAMES: [string, string][] = [
  ["automod_timeout_minutes", "timeout_minutes"],
  ["autoban_delete_hours", "auto_wipe_hours"],
  ["antiscam_spray_action", "scam_spray_action"],
  ["antiscam_spray_channels", "scam_spray_channels"],
  ["antiscam_spray_seconds", "scam_spray_seconds"],
  ["antiscam_spray_similarity", "scam_spray_similarity"],
  ["antiscam_spray_min_chars", "scam_spray_min_chars"],
  ["antiscam_spray_match_attachments", "scam_spray_match_attachments"],
  ["antiscam_spray_exempt_staff", "scam_spray_exempt_staff"],
  ["antiscam_blocklist_action", "scam_signature_action"],
  ["antiscam_seed_from_honeypot", "scam_seed_from_honeypot"],
  ["antiscam_seed_domains", "scam_seed_domains"],
  ["antiscam_seed_images", "scam_seed_images"],
  ["antiscam_seed_max_bytes", "scam_max_image_mb"],
  ["antiscam_seed_ttl_days", "scam_seed_ttl_days"],
  ["antiscam_seed_max_entries", "scam_seed_max_entries"],
];

// Keys that no longer exist (magnitudes centralized, or toggles that are now always-on).
const CONFIG_DROPS = [
  "antiscam_spray_timeout_minutes",
  "antiscam_spray_purge",
  "antiscam_bare_domains",
  "antiscam_scan_embeds",
  "antiscam_scan_attachment_names",
  "automod_ban_delete_hours",
  "honeypot_delete_hours",
];

// Bring a stored config forward to the current key names. Idempotent (a re-run finds no old keys)
// and transactional. Call once at boot before serving.
export function migrateConfig(db: BotDatabase): void {
  const run = db.transaction(() => {
    for (const [oldKey, newKey] of CONFIG_RENAMES) {
      db.query(
        `UPDATE guild_config SET key = ? WHERE key = ?
         AND guild_id NOT IN (SELECT guild_id FROM guild_config WHERE key = ?)`,
      ).run(newKey, oldKey, newKey);
      db.query("DELETE FROM guild_config WHERE key = ?").run(oldKey);
    }
    for (const key of CONFIG_DROPS) db.query("DELETE FROM guild_config WHERE key = ?").run(key);
  });
  run();
}

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
