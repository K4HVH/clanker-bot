import { defineServer } from "../../../src/server/spec";

const hidden = { everyone: { ViewChannel: false } } as const;
const members = { everyone: { ViewChannel: false }, verified: { ViewChannel: true } } as const;

// A server shaped like Medius, for the apply tests: three roles, two categories, six channels,
// Community, one AutoMod rule, one post and four settings.
export default defineServer({
  name: "fixture",
  dir: import.meta.dir,
  guild: {
    verificationLevel: "medium",
    explicitContentFilter: "all",
    community: { rules: "rules", updates: "staff-updates" },
    systemChannel: "logs",
    requireMfa: true,
  },
  everyone: { permissions: ["CreateInstantInvite", "ReadMessageHistory"] },
  roles: [
    { key: "dev", name: "Dev", color: 1, hoist: true, mentionable: true, permissions: ["Administrator"] },
    { key: "mod", name: "Mod", permissions: ["KickMembers", "ModerateMembers", "ManageMessages"] },
    { key: "verified", name: "Verified", permissions: ["ViewChannel", "SendMessages"] },
  ],
  channels: [
    { key: "rules", type: "text", name: "rules", overwrites: { everyone: { ViewChannel: true, SendMessages: false } } },
    {
      key: "home",
      type: "category",
      name: "Home",
      overwrites: members,
      channels: [
        { key: "general", type: "text", name: "general", topic: "Chat", overwrites: members },
        { key: "compatibility", type: "text", name: "compatibility", slowmode: 60, overwrites: members },
        { key: "vc", type: "voice", name: "vc", overwrites: members },
      ],
    },
    {
      key: "admin",
      type: "category",
      name: "Admin",
      overwrites: hidden,
      channels: [
        { key: "logs", type: "text", name: "logs", overwrites: hidden },
        { key: "staff-updates", type: "text", name: "staff-updates", overwrites: hidden },
      ],
    },
  ],
  automod: [
    { key: "rule-2", name: "Rule 2", keywords: ["*cheat*"], regex: ["sell.{0,10}hack"], block: "Blocked.", alert: "logs", exemptRoles: ["dev"] },
  ],
  posts: [{ key: "rules", channel: "rules", file: "rules.md" }],
  bot: {
    mod_log_channel_id: { channel: "logs" },
    verified_role_id: { role: "verified" },
    ticket_category_id: { channel: "admin" },
    automod_invites: false,
  },
});
