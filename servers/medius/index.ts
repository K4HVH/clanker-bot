import { defineServer } from "../../src/server/spec";

// The Medius server. Channels and roles that already exist carry their former names in `was`, so the
// first plan binds them and renames them, keeping their history. See medius-fw
// docs/superpowers/specs/2026-10-11-discord-rework-design.md.

// Read-only for those who can see the channel: they read and react, nobody posts.
const readOnly = {
  SendMessages: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  SendMessagesInThreads: false,
} as const;

export default defineServer({
  name: "medius",
  dir: import.meta.dir,
  guild: {
    name: "Medius",
    description: "Free replacement firmware for the MAKCU, and news on the Medius box.",
    splash: "invite.png", // the site's link-card background at 1920x1080
    verificationLevel: "medium",
    explicitContentFilter: "all",
    defaultNotifications: "mentions",
    systemChannel: "logs",
    safetyAlertsChannel: "logs",
    community: { rules: "rules", updates: "logs" },
    requireMfa: true,
  },
  everyone: {
    permissions: ["CreateInstantInvite", "ReadMessageHistory", "RequestToSpeak"],
  },
  roles: [
    {
      key: "dev",
      name: "Dev",
      color: 1,
      hoist: true,
      mentionable: true,
      permissions: ["CreateInstantInvite", "KickMembers", "BanMembers", "Administrator", "ManageChannels", "ManageGuild", "AddReactions", "ViewAuditLog", "PrioritySpeaker", "Stream", "ViewChannel", "SendMessages", "SendTTSMessages", "ManageMessages", "EmbedLinks", "AttachFiles", "ReadMessageHistory", "MentionEveryone", "UseExternalEmojis", "Connect", "Speak", "MuteMembers", "DeafenMembers", "MoveMembers", "UseVAD", "ChangeNickname", "ManageNicknames", "ManageRoles", "ManageWebhooks", "ManageGuildExpressions", "UseApplicationCommands", "ManageEvents", "ManageThreads", "CreatePublicThreads", "CreatePrivateThreads", "UseExternalStickers", "SendMessagesInThreads", "UseEmbeddedActivities", "ModerateMembers", "UseSoundboard", "CreateGuildExpressions", "CreateEvents", "UseExternalSounds", "SendVoiceMessages", "SetVoiceChannelStatus", "SendPolls", "UseExternalApps", "PinMessages", "BypassSlowmode"],
    },
    {
      key: "cool-people",
      name: "Cool People",
      color: 15277667,
      hoist: true,
      permissions: [],
    },
    {
      key: "donators",
      name: "Donators",
      color: 15844367,
      hoist: true,
      permissions: [],
    },
    {
      key: "verified",
      name: "Verified",
      permissions: ["CreateInstantInvite", "AddReactions", "Stream", "ViewChannel", "SendMessages", "EmbedLinks", "AttachFiles", "ReadMessageHistory", "UseExternalEmojis", "Connect", "Speak", "UseVAD", "ChangeNickname", "UseExternalStickers", "SendMessagesInThreads", "UseSoundboard", "CreateGuildExpressions", "UseExternalSounds"],
    },
    // Everyone in the server at the first Apply got @everyone release pings: they keep them, and can
    // drop the role in Channels & Roles. Later joiners choose in onboarding.
    { key: "release-pings", name: "Release Pings", was: ["Release pings"], permissions: [], grantToExisting: true },
    { key: "box-pings", name: "Box Pings", was: ["Box pings"], permissions: [] },
  ],
  botRole: { color: 0x1abc9c, hoist: true, mentionable: true, after: "dev" },
  channels: [
    {
      key: "verify",
      type: "text",
      name: "verify",
      slowmode: 15,
      overwrites: {
        everyone: {
          CreateInstantInvite: true,
          AddReactions: true,
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          ManageChannels: false,
          SendTTSMessages: false,
          ManageMessages: false,
          EmbedLinks: false,
          AttachFiles: false,
          MentionEveryone: false,
          UseExternalEmojis: false,
          ManageRoles: false,
          ManageWebhooks: false,
          UseApplicationCommands: false,
          ManageThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          UseExternalStickers: false,
          SendMessagesInThreads: false,
          UseEmbeddedActivities: false,
          SendVoiceMessages: false,
          SendPolls: false,
          UseExternalApps: false,
          PinMessages: false,
          BypassSlowmode: false,
        },
        verified: {
          ViewChannel: false,
        },
      },
    },
    {
      key: "rules",
      type: "text",
      name: "📜-rules",
      was: ["rules"],
      overwrites: { verified: { AddReactions: false, ...readOnly } },
    },
    {
      key: "start-here",
      type: "text",
      name: "👋-start-here",
      was: ["start-here"],
      overwrites: { verified: { AddReactions: false, ...readOnly } },
    },
    {
      key: "support",
      type: "category",
      name: "- Support",
      was: ["Support", "- Support"],
      overwrites: { verified: { ...readOnly } },
      channels: [
        { key: "help", type: "text", name: "❓-help" },
        { key: "ticket", type: "text", name: "🎟️-ticket", was: ["ticket"] },
      ],
    },
    {
      key: "medius",
      type: "category",
      name: "- Medius Firmware",
      was: ["- Important", "Medius", "- Medius firmware"],
      channels: [
        {
          key: "releases",
          type: "announcement",
          name: "📝-changelog",
          was: ["releases"],
          overwrites: { verified: { ...readOnly } },
          publish: true,
        },
        {
          key: "device-reports",
          type: "text",
          name: "✅-device-reports",
          was: ["✅-compatibility", "device-reports"],
          slowmode: 60,
          topic: "Post each device you've tried: whether it works through the box, and your firmware version. For help with one that doesn't, open a ticket. List: https://medius.k4tech.net/guide/compatibility",
        },
        {
          key: "suggestions-bugs",
          type: "text",
          name: "💡-suggestions-bugs",
          was: ["suggestions-bugs"],
          slowmode: 60,
        },
      ],
    },
    {
      key: "medius-box",
      type: "category",
      name: "- Medius Box",
      was: ["- Hardware", "Medius box", "- Medius box"],
      channels: [
        {
          key: "box-updates",
          type: "announcement",
          name: "⏳-progress",
          was: ["box-updates"],
          overwrites: { verified: { ...readOnly } },
          publish: true,
        },
        { key: "box-chat", type: "text", name: "hardware-chat", was: ["box-chat"] },
      ],
    },
    {
      key: "community",
      type: "category",
      name: "- Home",
      was: ["Community"],
      channels: [
        { key: "general", type: "text", name: "general" },
        { key: "vouches", type: "text", name: "⭐-vouch", was: ["vouches"], slowmode: 300 },
        { key: "voice", type: "voice", name: "🗣️-vc", was: ["Voice"] },
      ],
    },
    {
      key: "cool-stuff",
      type: "category",
      name: "- Other Cool Stuff",
      was: ["- Developers", "Developers"],
      channels: [{ key: "abcurves", type: "text", name: "abcurves", overwrites: { verified: { ...readOnly } } }],
    },
    {
      key: "tickets",
      type: "category",
      name: "- Tickets",
      was: ["Tickets"],
      others: "keep",
      overwrites: { everyone: { ViewChannel: false } },
      channels: [],
    },
    {
      key: "admin",
      type: "category",
      name: "Admin",
      overwrites: { everyone: { ViewChannel: false } },
      channels: [
        { key: "logs", type: "text", name: "logs" },
        { key: "backup", type: "text", name: "backup" },
      ],
    },
  ],
  retired: [
    { key: "website", name: "🌐-website", was: ["website"], into: "backup" },
    { key: "faqs", name: "❓-faqs", was: ["faqs"], into: "backup" },
    { key: "guides", name: "🧭-guides", was: ["guides"], into: "backup" },
    { key: "tools", name: "🔧-tools", was: ["tools"], into: "backup" },
    { key: "box-intro", name: "🔲-medius-box", was: ["box-intro"], into: "backup" },
  ],
  // Discord's own spam checks, as Medius has them (the mention-spam rule is the one Discord makes when
  // Community comes on). No keyword rules: rule 2 is enforced by staff.
  automod: [
    { key: "spam", name: "Block Suspected Spam Content", trigger: "spam", block: true, alert: "logs", exemptChannels: ["logs"] },
    { key: "mention-spam", name: "Block Mention Spam", trigger: "mentions", mentionLimit: 20, raidProtection: true, block: true },
  ],
  onboarding: {
    enabled: true,
    defaultChannels: ["verify"],
    questions: [
      {
        title: "Pings",
        options: [
          { title: "Releases", description: "Each Medius release", roles: ["release-pings"] },
          { title: "Medius box", description: "Medius box news", roles: ["box-pings"] },
        ],
      },
    ],
  },
  posts: [
    { key: "rules", channel: "rules", file: "rules.md" },
    { key: "welcome", channel: "start-here", file: "welcome.md" },
    { key: "help", channel: "help", file: "help.md" },
    { key: "ticket-panel", channel: "ticket", panel: "ticket" },
    { key: "verify-panel", channel: "verify", panel: "verify" },
  ],
  bot: {
    automod_executables: true,
    automod_executable_exts: ".exe, .dll, .sys, .scr, .msi, .bat, .cmd, .ps1",
    automod_invites: false,
    retention_moderation_days: 365,
    retention_tickets_days: 365,
    retention_member_log_days: 90,
    verification_channel_id: { channel: "verify" },
    verification_welcome_channel_id: { channel: "start-here" },
    ticket_category_id: { channel: "tickets" },
    mod_log_channel_id: { channel: "logs" },
    member_log_channel_id: { channel: "logs" },
    verified_role_id: { role: "verified" },
  },
});
