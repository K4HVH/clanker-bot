import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PermissionFlagsBits } from "discord.js";
import { readLive } from "../../src/server/live";
import { buildPlan, type Op, type Plan } from "../../src/server/plan";
import { defineServer, type ServerSpec } from "../../src/server/spec";
import { type State, stateKey } from "../../src/server/state";
import { FakeDiscord } from "../helpers/fake-discord";

const ASSETS = `${import.meta.dir}/fixture-assets`;

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: ASSETS,
    guild: {},
    everyone: { permissions: [] },
    roles: [{ key: "dev", name: "Dev", permissions: ["Administrator"] }],
    channels: [
      { key: "rules", type: "text", name: "rules" },
      { key: "logs", type: "text", name: "logs" },
    ],
    automod: [],
    posts: [],
    bot: {},
    ...over,
  });

// A fake server already matching spec(): its objects and the state binding them.
function matching() {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const rules = f.addChannel({ name: "rules", position: 0 });
  const logs = f.addChannel({ name: "logs", position: 1 });
  const state: State = new Map([
    [stateKey("role", "dev"), dev.id],
    [stateKey("channel", "rules"), rules.id],
    [stateKey("channel", "logs"), logs.id],
  ]);
  return { f, dev, rules, logs, state };
}

const plan = async (
  f: FakeDiscord,
  s: ServerSpec,
  state: State,
  settings: Record<string, unknown> = {},
  posts: { channelId: string; messageId: string }[] = [],
): Promise<Plan> => buildPlan({ spec: s, live: await readLive(f, f.guildId, posts), state, settings, deletions: false });

const only = (p: Plan, t: Op["t"]) => p.ops.filter((o) => o.t === t);

test("server settings: raising is plain, lowering is flagged", async () => {
  const { f, state } = matching();
  f.guild.explicit_content_filter = 2;
  const p = await plan(f, spec({ guild: { verificationLevel: "medium", explicitContentFilter: "off", name: "Medius" } }), state);
  expect(p.ops).toEqual([
    {
      t: "guild.update",
      changes: [
        { field: "name", from: "Test", to: "Medius" },
        { field: "verificationLevel", from: "none", to: "medium" },
        { field: "explicitContentFilter", from: "all", to: "off" },
      ],
      flags: ["widens"],
    },
  ]);
});

test("Community is turned on after its channels exist", async () => {
  const f = new FakeDiscord();
  const p = await plan(
    f,
    spec({ roles: [], guild: { verificationLevel: "medium", explicitContentFilter: "all", community: { rules: "rules", updates: "logs" } } }),
    new Map(),
  );
  const kinds = p.ops.map((o) => o.t);
  expect(kinds.indexOf("community")).toBeGreaterThan(kinds.lastIndexOf("channel.create"));
  expect(only(p, "community")).toEqual([{ t: "community", enable: true, flags: [] }]);
});

test("Community without its requirements is a manual step", async () => {
  const { f, state } = matching();
  const p = await plan(f, spec({ guild: { explicitContentFilter: "off", community: { rules: "rules", updates: "logs" } } }), state);
  expect(only(p, "community")).toEqual([]);
  expect(p.manual).toEqual([
    "Community needs the explicit-content filter on all members: set guild.explicitContentFilter to \"all\" in the file",
    "Community needs a verification level of low or higher: set guild.verificationLevel in the file",
  ]);
});

test("turning Community off is flagged", async () => {
  const { f, state } = matching();
  f.guild.features = ["COMMUNITY"];
  const p = await plan(f, spec({ guild: { community: false } }), state);
  expect(p.ops).toEqual([{ t: "community", enable: false, flags: ["deletes"] }]);
});

test("Community's channels follow the file", async () => {
  const { f, state, rules, logs } = matching();
  f.guild.features = ["COMMUNITY"];
  f.guild.rules_channel_id = logs.id;
  f.guild.public_updates_channel_id = rules.id;
  f.guild.explicit_content_filter = 2;
  f.guild.verification_level = 2;
  const p = await plan(f, spec({ guild: { community: { rules: "rules", updates: "logs" } } }), state);
  expect(p.ops).toEqual([
    {
      t: "guild.update",
      changes: [
        { field: "rulesChannel", from: "logs", to: "rules" },
        { field: "updatesChannel", from: "rules", to: "logs" },
      ],
      flags: [],
    },
  ]);
});

test("2FA for moderation is a manual step when the file asks for it", async () => {
  const { f, state } = matching();
  expect((await plan(f, spec(), state)).manual).toEqual([]);
  expect((await plan(f, spec({ guild: { requireMfa: true } }), state)).manual).toEqual([
    "Owner: turn on 2FA for moderation in Server Settings > Safety Setup > Permissions > Require 2FA for moderator actions. First turn on 2FA (User Settings > My Account > Enable Authenticator App) for your account and for the account that owns the bot's application: without it the bot can't give roles, kick or ban once this is on",
  ]);
  f.guild.mfa_level = 1;
  expect((await plan(f, spec({ guild: { requireMfa: true } }), state)).manual).toEqual([]);
});

test("an icon is set, bound, or left alone by its hash", async () => {
  const { f, state } = matching();
  const hash = createHash("sha256").update(readFileSync(`${ASSETS}/icon.png`)).digest("hex");
  const s = spec({ guild: { icon: "icon.png" } });
  expect(only(await plan(f, s, state), "asset.set")).toEqual([{ t: "asset.set", key: "icon", file: "icon.png", hash }]);
  f.guild.icon = "a1b2";
  expect((await plan(f, s, state)).ops).toEqual([{ t: "bind", kind: "asset", key: "icon", id: hash, label: "icon" }]);
  expect((await plan(f, s, new Map([...state, [stateKey("asset", "icon"), hash]]))).ops).toEqual([]);
});

const rule2 = { key: "rule-2", name: "Rule 2", keywords: ["*cheat*"], regex: ["sell.*hack"], block: "No.", alert: "logs", exemptRoles: ["dev"] };

test("an AutoMod rule is created, bound and updated", async () => {
  const { f, state, logs, dev } = matching();
  f.addRule({ name: "Block Suspected Spam Content", trigger_type: 3 });
  const created = await plan(f, spec({ automod: [rule2] }), state);
  expect(only(created, "automod.create")).toEqual([
    {
      t: "automod.create",
      key: "rule-2",
      body: {
        name: "Rule 2",
        trigger: 1,
        mentionLimit: null,
        raidProtection: null,
        enabled: true,
        keywords: ["*cheat*"],
        regex: ["sell.*hack"],
        allow: [],
        actions: [{ type: 1, message: "No." }, { type: 2, channel: "logs" }],
        exemptRoles: ["dev"],
        exemptChannels: [],
      },
    },
  ]);
  expect(created.unmanaged).toContain('AutoMod "Block Suspected Spam Content"');

  const live = f.addRule({
    name: "Rule 2",
    trigger_metadata: { keyword_filter: ["*cheat*"], regex_patterns: ["sell.*hack"], allow_list: [] },
    actions: [{ type: 1, metadata: { custom_message: "No." } }, { type: 2, metadata: { channel_id: logs.id } }],
    exempt_roles: [dev.id],
  });
  expect((await plan(f, spec({ automod: [rule2] }), state)).ops).toEqual([
    { t: "bind", kind: "automod", key: "rule-2", id: live.id, label: 'AutoMod "Rule 2"' },
  ]);
  const bound = new Map([...state, [stateKey("automod", "rule-2"), live.id]]);
  const changed = await plan(f, spec({ automod: [{ ...rule2, keywords: ["*cheat*", "*hack*"] }] }), bound);
  expect(changed.ops).toMatchObject([{ t: "automod.update", key: "rule-2", changes: [{ field: "keywords" }] }]);
});

test("bot settings compare against stored values and defaults", async () => {
  const { f, state, logs } = matching();
  const s = spec({ bot: { mod_log_channel_id: { channel: "logs" }, dm_on_action: false, timeout_minutes: 15 } });
  const p = await plan(f, s, state, { mod_log_channel_id: "999", automod_caps: true });
  expect(p.ops).toEqual([
    { t: "setting.set", key: "mod_log_channel_id", value: { channel: "logs" }, before: "999" },
    { t: "setting.set", key: "timeout_minutes", value: 15, before: 10 },
  ]);
  expect(p.unmanaged).toContain("1 bot setting set in /config but not in the file");
  const same = await plan(f, s, state, { mod_log_channel_id: logs.id, timeout_minutes: 15 });
  expect(same.ops).toEqual([]);
});

test("posts are created, edited, recreated and trimmed by chunk", async () => {
  const { f, state, rules } = matching();
  const s = spec({ posts: [{ key: "rules", channel: "rules", file: "post.md" }] });
  const created = await plan(f, s, state);
  expect(only(created, "post.create")).toEqual([
    { t: "post.create", key: "rules", index: 0, channel: "rules", content: readFileSync(`${ASSETS}/post.md`, "utf8").trim() },
  ]);

  const m0 = f.addMessage(rules.id, "old text");
  const m1 = f.addMessage(rules.id, "extra chunk");
  const posted = new Map([
    ...state,
    [stateKey("post", "rules#0"), `${rules.id}/${m0.id}`],
    [stateKey("post", "rules#1"), `${rules.id}/${m1.id}`],
  ]);
  const ids = [
    { channelId: rules.id, messageId: m0.id },
    { channelId: rules.id, messageId: m1.id },
  ];
  const edited = await plan(f, s, posted, {}, ids);
  expect(edited.ops.map((o) => o.t)).toEqual(["post.edit", "post.delete"]);

  f.messages = f.messages.filter((m) => m.id !== m0.id);
  const gone = await plan(f, s, posted, {}, ids);
  expect(gone.ops.map((o) => o.t)).toEqual(["post.create", "post.delete"]);
});

test("the fingerprint follows the live server", async () => {
  const { f, state, rules } = matching();
  const a = await plan(f, spec(), state);
  const b = await plan(f, spec(), state);
  expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(b.fingerprint).toBe(a.fingerprint);
  f.channels.find((c) => c.id === rules.id)!.topic = "changed by hand";
  expect((await plan(f, spec(), state)).fingerprint).not.toBe(a.fingerprint);
});

// Discord lists what it keys by id in any order: Medius's 13 features and #abcurves's overwrites came back shuffled
// on every read, so no Apply matched its plan.
test("the fingerprint and the plan ignore the order Discord lists things in", async () => {
  const { f, state, rules, logs, dev } = matching();
  const helper = f.addRole({ name: "Helper", position: 2 });
  f.guild.features = ["INVITE_SPLASH", "ANIMATED_ICON", "AUTO_MODERATION"];
  f.invites = [
    { code: "a", channel: { id: rules.id }, uses: 0, max_age: 0 },
    { code: "b", channel: { id: logs.id }, uses: 0, max_age: 86400 },
  ];
  const ch = f.channels.find((c) => c.id === rules.id)!;
  ch.permission_overwrites = [
    { id: "900", type: 1, allow: "1024", deny: "0" },
    { id: "901", type: 1, allow: "1024", deny: "0" },
    { id: dev.id, type: 0, allow: "0", deny: "2048" },
  ];
  f.addRule({ name: "Spam", trigger_type: 3, exempt_roles: [dev.id, helper.id], exempt_channels: [rules.id, logs.id] });
  f.onboarding = {
    enabled: false,
    mode: 0,
    default_channel_ids: [rules.id, logs.id],
    prompts: [{ id: "p", type: 0, title: "Pings", single_select: false, required: false, in_onboarding: true, options: [{ id: "o", title: "All", description: null, role_ids: [dev.id, helper.id], channel_ids: [rules.id, logs.id] }] }],
  };
  const a = await plan(f, spec(), state);

  f.guild.features = ["AUTO_MODERATION", "INVITE_SPLASH", "ANIMATED_ICON"];
  f.invites.reverse();
  ch.permission_overwrites.reverse();
  f.roles.reverse();
  f.channels.reverse();
  f.rules[0]!.exempt_roles.reverse();
  f.rules[0]!.exempt_channels.reverse();
  f.onboarding.default_channel_ids.reverse();
  f.onboarding.prompts[0]!.options[0]!.role_ids.reverse();
  f.onboarding.prompts[0]!.options[0]!.channel_ids.reverse();
  const b = await plan(f, spec(), state);
  expect(b.unmanaged).toEqual(a.unmanaged);
  expect(b.fingerprint).toBe(a.fingerprint);
});

test("an AutoMod rule's exemptions compare as sets", async () => {
  const { f, state, rules, logs, dev } = matching();
  const helper = f.addRole({ name: "Helper", position: 2 });
  const live = f.addRule({ name: "Spam", trigger_type: 3, exempt_roles: [helper.id, dev.id], exempt_channels: [logs.id, rules.id] });
  const s = spec({
    roles: [
      { key: "dev", name: "Dev", permissions: ["Administrator"] },
      { key: "helper", name: "Helper", permissions: [] },
    ],
    automod: [{ key: "spam", name: "Spam", trigger: "spam", exemptRoles: ["dev", "helper"], exemptChannels: ["rules", "logs"] }],
  });
  const bound = new Map([...state, [stateKey("role", "helper"), helper.id], [stateKey("automod", "spam"), live.id]]);
  expect(only(await plan(f, s, bound), "automod.update")).toEqual([]);
});

test("an announcement channel without Community is a manual step", async () => {
  const f = new FakeDiscord();
  const p = await plan(f, spec({ roles: [], channels: [{ key: "news", type: "announcement", name: "news" }] }), new Map());
  expect(p.ops.filter((o) => o.t === "channel.create")).toEqual([]);
  expect(p.manual).toEqual(['#news needs Community on: turn it on in the file (guild.community), or make it a text channel there']);
});

describe("a key that can't be planned", () => {
  test("nothing that names it is planned, so Apply never stops on it", async () => {
    const f = new FakeDiscord();
    const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
    f.addChannel({ name: "logs" });
    f.addChannel({ name: "logs" });
    const rules = f.addChannel({ name: "rules" });
    const state: State = new Map([[stateKey("role", "dev"), dev.id], [stateKey("channel", "rules"), rules.id]]);
    const s = spec({
      guild: { systemChannel: "logs" },
      bot: { mod_log_channel_id: { channel: "logs" } },
      posts: [{ key: "notes", channel: "logs", file: "post.md" }],
      automod: [{ key: "r", name: "R", keywords: ["x"], alert: "logs" }],
    });
    const p = await plan(f, s, state);
    expect(p.manual).toEqual(['2 channels named "logs": rename one in Discord so "logs" can bind to the other, then plan again']);
    expect(p.ops).toEqual([]);
  });

  test("a category that can't be planned takes its channels with it", async () => {
    const f = new FakeDiscord();
    const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
    f.addChannel({ name: "Info", type: 4 });
    f.addChannel({ name: "Info", type: 4 });
    const state: State = new Map([[stateKey("role", "dev"), dev.id]]);
    const s = spec({
      channels: [{ key: "info", type: "category", name: "Info", channels: [{ key: "rules", type: "text", name: "rules" }] }],
      bot: { mod_log_channel_id: { channel: "rules" } },
      posts: [{ key: "rules", channel: "rules", file: "post.md" }],
    });
    const p = await plan(f, s, state);
    expect(p.ops).toEqual([]);
  });
});

test("a bot without Administrator is told before it fails", async () => {
  const { f, state } = matching();
  expect((await plan(f, spec(), state)).manual).toEqual([]);
  f.roles.find((r) => r.tags?.bot_id === f.botId)!.permissions = String(PermissionFlagsBits.ManageChannels);
  expect((await plan(f, spec(), state)).manual).toEqual([
    "Give the bot's role Administrator in Server Settings > Roles > (the bot's role) > Permissions > Administrator, and drag it to the top. Turning Community on, AutoMod and posting in read-only channels need it",
  ]);
});
