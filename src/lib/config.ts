import { ChannelType } from "discord.js";
import { GUARD_ACTIONS, SCAM_ACTIONS } from "./actions";
import { DEFAULT_EXECUTABLE_EXTS } from "./automod";
import { CHECK_CATEGORIES } from "./ticket-check";
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
  automodExecutables: "automod_executables",
  automodExecutableExts: "automod_executable_exts",
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
  ticketMinSubjectWords: "ticket_min_subject_words",
  // Ticket Check: the generated reasoning test that gates opening a ticket.
  ticketCheckEnabled: "ticket_check_enabled",
  ticketCheckCategories: "ticket_check_categories",
  ticketCheckIntroText: "ticket_check_intro_text",
  ticketCheckQuestions: "ticket_check_questions",
  ticketCheckRequired: "ticket_check_required",
  ticketCheckSeconds: "ticket_check_seconds",
  ticketCheckPassDays: "ticket_check_pass_days",
  ticketCheckCooldownMinutes: "ticket_check_cooldown_minutes",
  ticketCheckExemptRoles: "ticket_check_exempt_roles",
  ticketCheckExemptStaff: "ticket_check_exempt_staff",
  ticketCheckFailText: "ticket_check_fail_text",
  ticketCheckLogFailures: "ticket_check_log_failures",
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
  // Verification: the channel the success message points at.
  verificationWelcomeChannelId: "verification_welcome_channel_id",
  // Privacy: how long the bot keeps what it records about members.
  retentionModerationDays: "retention_moderation_days",
  retentionTicketsDays: "retention_tickets_days",
  retentionMemberLogDays: "retention_member_log_days",
  // Device feed: new and changed devices on the site's Devices list, posted as they appear.
  deviceFeedChannelId: "device_feed_channel_id",
  deviceFeedUrl: "device_feed_url",
  // Comparison: the site's comparison summary, kept in a channel.
  comparisonChannelId: "comparison_channel_id",
  comparisonUrl: "comparison_url",
} as const;

// ── Registry: the single source of truth for every setting ──────────────────
// "role"/"choice" hold one value; "roles"/"multichoice" hold a list, and both are picked
// from a native Discord select rather than typed out by hand.
export type SettingType =
  | "bool"
  | "int"
  | "text"
  | "channel"
  | "role"
  | "roles"
  | "choice"
  | "multichoice";

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
  { id: "automod-attachments", label: "Automod Attachments", accentColor: 0xc0392b },
  { id: "automod-scam", label: "Automod Scam", accentColor: 0xd35400 },
  { id: "automod-scam-seed", label: "Automod Scam Seeding", accentColor: 0xd35400 },
  { id: "guards", label: "Guards", accentColor: 0x9b59b6 },
  { id: "verification", label: "Verification", accentColor: 0x2ecc71 },
  { id: "tickets", label: "Tickets", accentColor: 0x3498db },
  { id: "ticket-check", label: "Ticket Check", accentColor: 0x2980b9 },
  { id: "ticket-check-results", label: "Ticket Check Results", accentColor: 0x2980b9 },
  { id: "memes", label: "Memes", accentColor: 0xe67e22 },
  { id: "honeypot", label: "Honeypot", accentColor: 0xf1c40f },
  { id: "privacy", label: "Privacy", accentColor: 0x95a5a6 },
  { id: "device-feed", label: "Device Feed", accentColor: 0x2ecc71 },
  { id: "comparison", label: "Comparison", accentColor: 0x2ecc71 },
];

const K = CONFIG_KEYS;

// Offered by the ticket check's category picker. Derived from the check itself, so adding
// a question category makes it selectable without a second list to keep in step.
const CHECK_CATEGORY_CHOICES = CHECK_CATEGORIES.map((c) => ({
  value: c,
  label: c.charAt(0).toUpperCase() + c.slice(1),
}));

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
  { key: K.automodExecutables, category: "automod-attachments", type: "bool", default: false, label: "Block executable attachments", description: "Delete a message carrying a program (by the extensions below) from anyone without Manage Messages. Checked on messages with no text too." },
  { key: K.automodExecutableExts, category: "automod-attachments", type: "text", default: DEFAULT_EXECUTABLE_EXTS, label: "Executable extensions", description: "Attachment endings the check above blocks, comma or newline separated.", placeholder: ".exe, .dll, .bat" },
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
  { key: K.ticketStaffOnlyClose, category: "tickets", type: "bool", default: false, label: "Only staff can close tickets (not the opener)", description: "When on, the opener can't close it." },
  { key: K.ticketMinSubjectWords, category: "tickets", type: "int", min: 0, max: 30, default: 10, label: "Minimum words in the description (0=off)", description: "Refuse to open a ticket until the member has described the problem in at least this many words. Kills the two-word ticket nobody can act on. Discord enforces a rough length as they type, and the count is checked properly on submit. Staff opening a ticket for someone else are not asked." },
  // Ticket Check: a short generated reasoning test in front of ticket creation, for
  // guilds drowning in tickets from people who will not read. Off by default.
  { key: K.ticketCheckEnabled, category: "ticket-check", type: "bool", default: false, label: "Require a check before opening a ticket", description: "Ask a few generated reasoning questions before a ticket is created. Questions are built fresh every time, so there are no answers to share. Off by default." },
  { key: K.ticketCheckCategories, category: "ticket-check", type: "multichoice", choices: CHECK_CATEGORY_CHOICES, default: ["reasoning", "english"], label: "Question categories", description: "Which question sets are in play. Reasoning covers sequences, proportion and multi-step problems; English covers reading an instruction and putting a sentence together. Each selected category takes its turn, so one that is on always comes up. Selecting none uses every category rather than switching the check off." },
  { key: K.ticketCheckQuestions, category: "ticket-check", type: "int", min: 1, max: 5, default: 3, label: "Questions asked", description: "How many questions one check contains. Each comes from a different family, so no check repeats a shape." },
  { key: K.ticketCheckRequired, category: "ticket-check", type: "int", min: 1, max: 5, default: 3, label: "Correct answers needed", description: "How many must be right to pass. Clamped to the number asked, so the two settings can't be set to contradict each other." },
  { key: K.ticketCheckSeconds, category: "ticket-check", type: "int", min: 30, max: 600, default: 180, label: "Time limit (seconds)", description: "How long the whole check may take before it expires and counts as a failure." },
  { key: K.ticketCheckPassDays, category: "ticket-check-results", type: "int", min: 0, max: 365, default: 30, label: "A pass stays valid for (days)", description: "How long before a member has to sit the check again. 0 gates every ticket; 365 is effectively once ever." },
  { key: K.ticketCheckCooldownMinutes, category: "ticket-check-results", type: "int", min: 1, max: 1440, default: 30, label: "Cooldown after a failure (minutes)", description: "How long a failed member must wait before trying again. This is what stops someone rerolling questions until they get lucky." },
  { key: K.ticketCheckExemptRoles, category: "ticket-check", type: "roles", default: [], label: "Exempt roles", description: "Roles that skip the check. Use it for customers or veterans you never want gated." },
  { key: K.ticketCheckIntroText, category: "ticket-check", type: "text", default: "You need to pass a short intelligence check before you can open a ticket. Tickets are handled by a small team, so they're kept for the problems that need one. Read each question carefully.", label: "Intro text (first question)", description: "Shown above the first question only. Say why you ask, or point at the FAQ. The line giving the pass mark and the time left is added automatically, so it stays right when you change those." },
  { key: K.ticketCheckExemptStaff, category: "ticket-check", type: "bool", default: true, label: "Exempt staff", description: "Let Manage Server holders and the ticket staff role skip the check. A ticket staff opens for someone else with /ticket open for: is never gated either way." },
  { key: K.ticketCheckFailText, category: "ticket-check-results", type: "text", default: "Ask in the public help channels instead: more people see a question there, and an answer usually comes back sooner.", label: "Failure text", description: "Shown when someone doesn't pass, under the score. Point them at whichever channel you want them asking in; the bot supplies the verdict and the retry time around it." },
  { key: K.ticketCheckLogFailures, category: "ticket-check-results", type: "bool", default: true, label: "Log failures to the mod log", description: "Post who failed, what they answered, and when their cooldown lifts. Turn off if it gets noisy: the check keeps working either way." },
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
  { key: K.honeypotExemptRoles, category: "honeypot", type: "roles", default: [], label: "Exempt roles", description: "Roles never actioned. The owner and Manage Messages holders are always exempt." },
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
  { key: K.scamSeedTtlDays, category: "automod-scam-seed", type: "int", min: 1, max: 365, default: 30, label: "Seed: signature lifetime (days)", description: "Seeded signatures expire after this many days, so a wrong entry ages out." },
  { key: K.scamSeedMaxEntries, category: "automod-scam-seed", type: "int", min: 50, max: 5000, default: 500, label: "Seed: max stored signatures", description: "Cap on seeded signatures per kind. The oldest are evicted past this limit." },
  { key: K.verificationWelcomeChannelId, category: "verification", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "After verifying, point to", description: "The channel the success message names, where new members pick what they see." },
  // Privacy. Discord's Developer Terms have a bot delete what it no longer needs; these say when.
  { key: K.retentionModerationDays, category: "privacy", type: "int", min: 30, max: 3650, default: 365, label: "Keep moderation history (days)", description: "Warns, notes, bans and timeouts, and the bot's other mod-log posts, are deleted after this long." },
  { key: K.retentionTicketsDays, category: "privacy", type: "int", min: 30, max: 3650, default: 365, label: "Keep closed tickets (days)", description: "A closed ticket's record and transcript, and its closing post in the mod log, are deleted after this long." },
  { key: K.deviceFeedChannelId, category: "device-feed", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "Device feed channel", description: "Where devices new or changed on the site's Devices list are posted. Unset = off." },
  { key: K.deviceFeedUrl, category: "device-feed", type: "text", default: "https://medius.k4tech.net/api/devices", label: "Devices list", description: "The site's Devices list as JSON, read every 10 minutes." },
  { key: K.comparisonChannelId, category: "comparison", type: "channel", channelTypes: TEXT_CHANNELS, default: undefined, label: "Comparison channel", description: "Where the site's comparison summary is posted. Unset = off." },
  { key: K.comparisonUrl, category: "comparison", type: "text", default: "https://medius.k4tech.net/api/comparison", label: "Comparison summary", description: "The site's comparison summary as JSON, read every 10 minutes." },
  { key: K.retentionMemberLogDays, category: "privacy", type: "int", min: 7, max: 3650, default: 90, label: "Keep member-log posts (days)", description: "The bot's member-log posts (edited and deleted messages, joins, leaves, role and name changes) are deleted after this long." },
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

// Settings that used to be free-text lists of IDs and are now picked from a menu. Their
// stored value has to become an array, or the panel shows nothing selected and the next
// save silently replaces what the guild had.
const ROLE_LIST_KEYS = [CONFIG_KEYS.honeypotExemptRoles, CONFIG_KEYS.ticketCheckExemptRoles];

// Bring a stored config forward to the current key names and value shapes. Idempotent
// (a re-run finds nothing left to do) and transactional. Call once at boot before serving.
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

    for (const key of ROLE_LIST_KEYS) {
      for (const row of many<{ guildId: string; value: string }>(
        db,
        "SELECT guild_id AS guildId, value FROM guild_config WHERE key = ?",
        key,
      )) {
        let stored: unknown;
        try {
          stored = JSON.parse(row.value);
        } catch {
          // Not readable, so not something this can upgrade. Leaving it is survivable;
          // throwing here would roll back every other rename and kill startup.
          continue;
        }
        if (typeof stored !== "string") continue; // already a list
        db.query("UPDATE guild_config SET value = ? WHERE guild_id = ? AND key = ?").run(
          JSON.stringify(parseRoleIds(stored)),
          row.guildId,
          key,
        );
      }
    }
  });
  run();
}

const SNOWFLAKE = /^\d{17,20}$/;

// Discord shows at most 25 options in a select, which bounds what a list setting can hold.
export const ROLE_PICKER_MAX = 25;

// Role IDs from a "roles" setting, which the picker stores as a list. A string is still
// accepted for values typed in before the picker existed and for older config exports.
// Anything that isn't a snowflake is dropped rather than trusted: a stray word must never
// quietly widen an exemption.
export function parseRoleIds(raw: string[] | string | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(/[\n,]/);
  return parts.map((s) => s.trim()).filter((s) => SNOWFLAKE.test(s));
}

export function getSetting(key: string): Setting | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export function settingsByCategory(categoryId: string): Setting[] {
  return REGISTRY.filter((s) => s.category === categoryId);
}

// Bring a value up to the shape its setting holds today. Settings that used to be typed
// out as text are now picked from a menu and stored as a list, and a config exported
// before that change still carries the old form. Validation would reject it and import
// reports a rejection only as a count, so a restored backup would come back quietly
// missing settings the guild still expects to be there.
export function coerceSetting(setting: Setting, value: unknown): unknown {
  if (setting.type === "roles" && (typeof value === "string" || Array.isArray(value))) {
    const ids = parseRoleIds(value as string | string[]);
    // As below: something was named here, and dropping all of it would apply an empty
    // list as though that is what the guild asked for. Let validation refuse it instead.
    const named = (Array.isArray(value) ? value : value.split(/[\n,]/)).some(
      (part) => String(part).trim().length > 0,
    );
    return ids.length === 0 && named ? value : ids;
  }
  if (setting.type === "multichoice" && (typeof value === "string" || Array.isArray(value))) {
    const offered = new Set(setting.choices?.map((c) => c.value));
    const parts = Array.isArray(value) ? value.map(String) : value.split(/[\n,]/);
    const wanted = parts.map((part) => part.trim().toLowerCase());
    const known = wanted.filter((part) => offered.has(part));
    // An empty list means "every category", so coercing a named-but-unknown value down to
    // empty would switch everything on while the panel reported none. Hand back what came
    // in and let validation refuse it, so the admin is told instead.
    if (known.length === 0 && wanted.some((part) => part.length > 0)) return value;
    return known;
  }
  return value;
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
      // Discord's modal input cap. A longer value could be stored but never edited back
      // down through the panel, since building the modal to show it would throw.
      return typeof value === "string" && value.length <= 4000;
    case "channel":
    case "role":
      return typeof value === "string" && SNOWFLAKE.test(value);
    case "choice":
      return typeof value === "string" && (setting.choices?.some((c) => c.value === value) ?? false);
    case "roles":
      return (
        Array.isArray(value) &&
        // Discord's cap on a select. Anything longer could be stored but never shown,
        // and would be lost the first time an admin touched the picker.
        value.length <= ROLE_PICKER_MAX &&
        value.every((v) => typeof v === "string" && SNOWFLAKE.test(v)) &&
        new Set(value).size === value.length
      );
    case "multichoice":
      return (
        Array.isArray(value) &&
        value.every((v) => setting.choices?.some((c) => c.value === v) ?? false) &&
        new Set(value).size === value.length
      );
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
    if (stored !== undefined) return stored;
    // Copied, never handed out by reference: list defaults are shared by every guild, and
    // one caller pushing to what it got back would corrupt the default process-wide.
    const fallback = REGISTRY_BY_KEY.get(key)?.default;
    return (Array.isArray(fallback) ? [...fallback] : fallback) as T;
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
