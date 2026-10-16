import { expect, test } from "bun:test";
import { PermissionFlagsBits as P } from "discord.js";
import type { Plan } from "../../src/server/plan";
import { countText, renderPlan } from "../../src/server/render";
import { defineServer } from "../../src/server/spec";

const spec = defineServer({
  name: "t",
  dir: import.meta.dir,
  guild: {},
  everyone: { permissions: [] },
  roles: [
    { key: "dev", name: "Dev", permissions: [] },
    { key: "mod", name: "Mod", permissions: [] },
  ],
  channels: [
    { key: "rules", type: "text", name: "rules" },
    { key: "admin", type: "category", name: "Admin", channels: [{ key: "updates", type: "text", name: "discord-updates" }] },
  ],
  automod: [],
  posts: [],
  bot: {},
});

test("renders a plan as grouped lines", () => {
  const plan: Plan = {
    fingerprint: "f",
    ops: [
      { t: "bind", kind: "role", key: "dev", id: "1", label: 'role "Dev"' },
      { t: "role.create", key: "mod", name: "Mod", color: 0, hoist: false, mentionable: false, permissions: P.KickMembers | P.BanMembers, flags: [] },
      { t: "role.update", key: "dev", changes: [{ field: "permissions", from: P.SendMessages, to: P.Administrator }], flags: ["widens"] },
      { t: "role.order", keys: ["dev", "mod"] },
      { t: "channel.create", key: "updates", type: 0, name: "discord-updates", parent: "admin", topic: null, slowmode: 0, nsfw: false, overwrites: [], visibleTo: [], flags: [] },
      { t: "channel.update", key: "rules", changes: [{ field: "topic", from: "", to: "Read me" }], flags: [] },
      { t: "channel.order", items: [{ key: "rules", parent: null }, { key: "admin", parent: null }, { key: "updates", parent: "admin" }] },
      { t: "overwrite.set", channel: "rules", target: "everyone", allow: P.ViewChannel, deny: P.SendMessages, before: null, flags: ["widens"] },
      { t: "overwrite.delete", channel: "admin", target: "member:42", before: { allow: P.ViewChannel, deny: 0n }, flags: [] },
      { t: "guild.update", changes: [{ field: "explicitContentFilter", from: "off", to: "all" }], flags: [] },
      { t: "community", enable: true, flags: [] },
      { t: "automod.create", key: "rule-2", body: { name: "Rule 2", trigger: 1, mentionLimit: null, raidProtection: null, enabled: true, keywords: ["a", "b"], regex: ["c"], allow: [], actions: [{ type: 1 }, { type: 2, channel: "updates" }], exemptRoles: [], exemptChannels: [] } },
      { t: "setting.set", key: "mod_log_channel_id", value: { channel: "updates" }, before: "999" },
      { t: "setting.set", key: "timeout_minutes", value: 15, before: 10 },
      { t: "post.create", key: "rules", index: 0, channel: "rules", content: "x".repeat(812) },
    ],
    held: [{ t: "channel.delete", key: "old", name: "old", flags: ["deletes"] }],
    manual: ["Owner: turn on 2FA for moderation in Server Settings > Safety Setup > Permissions > Require 2FA for moderator actions. First turn on 2FA (User Settings > My Account > Enable Authenticator App) for your account and for the account that owns the bot's application: without it the bot can't give roles, kick or ban once this is on"],
    unmanaged: ['role "Cool People"'],
  };
  expect(renderPlan(plan, spec)).toBe(
    [
      "Bindings",
      '  bind role "Dev" -> dev',
      "",
      "Roles",
      '  + role "Mod": Kick Members, Ban Members',
      '  ! role "Dev": permissions +Administrator -Send Messages',
      "  order: Dev, Mod",
      "",
      "Channels",
      '  + #discord-updates (text, in category "Admin")',
      '  #rules: topic "" -> "Read me"',
      '  order: #rules, category "Admin", #discord-updates',
      "",
      "Permissions",
      "  ! #rules, @everyone: allow View Channel; deny Send Messages (was no overwrite)",
      '  category "Admin", member 42: removed (was allow View Channel)',
      "",
      "Server",
      "  explicit-content filter: off -> all",
      "  turn Community on",
      "",
      "AutoMod",
      '  + AutoMod "Rule 2": 2 keywords, 1 regex, block, alert #discord-updates',
      "",
      "Bot settings",
      "  mod_log_channel_id: 999 -> #discord-updates",
      "  timeout_minutes: 10 -> 15",
      "",
      "Posts",
      "  + rules, part 1 (812 characters) in #rules",
      "",
      "Held deletions (plan with deletions:true to apply them)",
      "  - #old",
      "",
      "Manual steps",
      "  Owner: turn on 2FA for moderation in Server Settings > Safety Setup > Permissions > Require 2FA for moderator actions. First turn on 2FA (User Settings > My Account > Enable Authenticator App) for your account and for the account that owns the bot's application: without it the bot can't give roles, kick or ban once this is on",
      "",
      "Unmanaged",
      '  role "Cool People"',
    ].join("\n"),
  );
});

test("an empty plan says so", () => {
  expect(renderPlan({ ops: [], held: [], manual: [], unmanaged: [], fingerprint: "f" }, spec)).toBe("No changes.");
});

test("an empty overwrite reads as one", () => {
  const plan: Plan = {
    fingerprint: "f",
    ops: [{ t: "overwrite.set", channel: "rules", target: "dev", allow: 0n, deny: 0n, before: { allow: 0n, deny: P.SendMessages }, flags: ["widens"] }],
    held: [],
    manual: [],
    unmanaged: [],
  };
  expect(renderPlan(plan, spec)).toBe("Permissions\n  ! #rules, Dev: empty overwrite (was deny Send Messages)");
});

test("forum tag changes read as tag names", () => {
  const plan: Plan = {
    fingerprint: "f",
    ops: [
      {
        t: "channel.update",
        key: "rules",
        changes: [{ field: "tags", from: [{ name: "Install", emoji: null, moderated: false }], to: [{ name: "Install", emoji: null, moderated: false }, { name: "Solved", emoji: "✅", moderated: true }] }],
        flags: [],
      },
    ],
    held: [],
    manual: [],
    unmanaged: [],
  };
  expect(renderPlan(plan, spec)).toBe('Channels\n  #rules: tags Install -> Install, ✅ Solved (staff only)');
});

test("a channel the plan makes shows its permissions with it", () => {
  const plan: Plan = {
    fingerprint: "f",
    ops: [
      {
        t: "channel.create",
        key: "rules",
        type: 0,
        name: "rules",
        parent: null,
        topic: null,
        slowmode: 0,
        nsfw: false,
        overwrites: [{ target: "mod", allow: 0n, deny: P.SendMessages }],
        visibleTo: ["mod"],
        flags: ["widens"],
      },
    ],
    held: [],
    manual: [],
    unmanaged: [],
  };
  expect(renderPlan(plan, spec)).toContain("Permissions\n  #rules (new), Mod: deny Send Messages");
});

test("the count names changes apart from bindings", () => {
  const ops = [
    { t: "bind", kind: "role", key: "dev", id: "1", label: 'role "Dev"' },
    { t: "guild.update", changes: [], flags: [] },
  ] as Plan["ops"];
  expect(countText({ fingerprint: "f", ops, held: [], manual: [], unmanaged: [] })).toBe("1 change, 1 binding");
  expect(countText({ fingerprint: "f", ops: [ops[1]!], held: [], manual: [], unmanaged: [] })).toBe("1 change");
});
