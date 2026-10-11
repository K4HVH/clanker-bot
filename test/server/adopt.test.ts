import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits as P } from "discord.js";
import { adoptSource, keyOf } from "../../src/server/adopt";
import { readLive } from "../../src/server/live";
import { buildPlan } from "../../src/server/plan";
import { type ServerSpec, validateSpec } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";

test("keys come from names", () => {
  expect(keyOf("📝-changelog", new Set())).toBe("changelog");
  expect(keyOf("- Important", new Set())).toBe("important");
  expect(keyOf("Cool People", new Set())).toBe("cool-people");
  expect(keyOf("🗣️", new Set())).toBe("channel");
  expect(keyOf("general", new Set(["general"]))).toBe("general-2");
  expect(keyOf("general", new Set(["general", "general-2"]))).toBe("general-3");
});

test("an adopted server plans nothing but bindings", async () => {
  const f = new FakeDiscord();
  f.guild.name = "Medius";
  f.guild.verification_level = 2;
  f.guild.default_message_notifications = 1;
  f.guild.mfa_level = 1;
  const dev = f.addRole({ name: "Dev", permissions: String(P.Administrator), position: 60, hoist: true, mentionable: true, color: 1 });
  const verified = f.addRole({ name: "Verified", permissions: String(P.SendMessages | P.ViewChannel), position: 2 });
  Object.assign(f.roles.find((r) => r.tags?.bot_id === f.botId)!, { color: 0x1abc9c, hoist: true });
  f.addRole({ name: "Server Booster", managed: true, tags: { premium_subscriber: null }, position: 1 });
  f.roles.find((r) => r.id === f.guildId)!.permissions = String(P.CreateInstantInvite | P.ReadMessageHistory);
  const verify = f.addChannel({ name: "verify", position: 0, rate_limit_per_user: 15, permission_overwrites: [{ id: f.guildId, type: 0, allow: String(P.ViewChannel), deny: "0" }, { id: verified.id, type: 0, allow: "0", deny: String(P.ViewChannel) }] });
  const home = f.addChannel({ name: "- Home", type: 4, position: 1, permission_overwrites: [{ id: verified.id, type: 0, allow: "0", deny: "0" }] });
  const general = f.addChannel({ name: "general", parent_id: home.id, position: 0, topic: "Chat" });
  f.addChannel({ name: "🗣️-vc", type: 2, parent_id: home.id, position: 1 });
  f.addChannel({ name: "abcurves", parent_id: home.id, position: 2, permission_overwrites: [{ id: "4242", type: 1, allow: String(P.ViewChannel), deny: "0" }] });
  f.addRule({ name: "Block Suspected Spam Content", trigger_type: 3 });
  f.addRule({
    name: "Rule 2",
    trigger_metadata: { keyword_filter: ["*cheat*"], regex_patterns: ["sell.*hack"], allow_list: [] },
    actions: [{ type: 1, metadata: { custom_message: "No." } }, { type: 2, metadata: { channel_id: general.id } }],
    exempt_roles: [dev.id],
  });
  const settings = { mod_log_channel_id: general.id, verified_role_id: verified.id, honeypot_exempt_roles: [dev.id], timeout_minutes: 15, verification_channel_id: "123456789012345678" };

  const live = await readLive(f, f.guildId, []);
  const source = adoptSource(live, settings, "medius", join(import.meta.dir, "../../src/server/spec.ts"));
  expect(source).toContain("// verification_channel_id: unknown channel 123456789012345678");
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  writeFileSync(join(dir, "index.ts"), source);
  const spec = (await import(join(dir, "index.ts"))).default as ServerSpec;

  expect(validateSpec(spec)).toEqual([]);
  expect(spec.channels.map((c) => c.key)).toEqual(["verify", "home"]);
  expect(spec.botRole).toEqual({ color: 0x1abc9c, hoist: true, after: "dev" });
  const plan = buildPlan({ spec, live, state: new Map(), settings, deletions: false });
  expect(plan.manual).toEqual([]);
  expect(new Set(plan.ops.map((o) => o.t))).toEqual(new Set(["bind"]));
  expect(plan.ops.map((o) => (o.t === "bind" ? `${o.kind}:${o.key}` : o.t))).toEqual([
    "role:dev",
    "role:verified",
    "channel:verify",
    "channel:home",
    "channel:general",
    "channel:abcurves",
    "channel:vc",
    "automod:rule-2",
  ]);
  expect(verify.id).toBeDefined();
});

test("adopt leaves out a channel's permissions when they match its category's", async () => {
  const f = new FakeDiscord();
  const deny = [{ id: f.guildId, type: 0 as const, allow: "0", deny: String(P.ViewChannel) }];
  const cat = f.addChannel({ name: "Admin", type: 4, permission_overwrites: deny });
  f.addChannel({ name: "logs", parent_id: cat.id, permission_overwrites: deny });
  f.addChannel({ name: "open", parent_id: cat.id, position: 1 });
  const live = await readLive(f, f.guildId, []);
  const source = adoptSource(live, {}, "t", join(import.meta.dir, "../../src/server/spec.ts"));
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  writeFileSync(join(dir, "index.ts"), source);
  const spec = (await import(join(dir, "index.ts"))).default as ServerSpec;
  const category = spec.channels[0] as { channels: { key: string; overwrites?: unknown }[] };
  expect(category.channels.find((c) => c.key === "logs")?.overwrites).toBeUndefined();
  expect(category.channels.find((c) => c.key === "open")?.overwrites).toEqual({});
  expect(buildPlan({ spec, live, state: new Map(), settings: {}, deletions: false }).ops.every((o) => o.t === "bind")).toBe(true);
});

test("adopt keeps media channels and leaves out kinds a spec can't hold", async () => {
  const f = new FakeDiscord();
  f.addChannel({ name: "clips", type: 16 });
  f.addChannel({ name: "Server Directory", type: 14 });
  const live = await readLive(f, f.guildId, []);
  const source = adoptSource(live, {}, "t", join(import.meta.dir, "../../src/server/spec.ts"));
  expect(source).toContain('type: "media"');
  expect(source).toContain("// Server Directory: a type 14 channel, which a spec can't hold");
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  writeFileSync(join(dir, "index.ts"), source);
  const spec = (await import(join(dir, "index.ts"))).default as ServerSpec;
  expect(validateSpec(spec)).toEqual([]);
  expect(buildPlan({ spec, live, state: new Map(), settings: {}, deletions: false }).ops.every((o) => o.t === "bind")).toBe(true);
});

test("adopt writes a forum's tags and settings", async () => {
  const f = new FakeDiscord();
  f.addChannel({
    name: "help",
    type: 15,
    topic: "Say what you tried.",
    flags: 16,
    available_tags: [{ id: "1", name: "Install", moderated: false, emoji_id: null, emoji_name: "📦" }, { id: "2", name: "Solved", moderated: true, emoji_id: null, emoji_name: null }],
    default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
    default_sort_order: 0,
    default_forum_layout: 1,
    default_thread_rate_limit_per_user: 30,
  });
  const live = await readLive(f, f.guildId, []);
  const source = adoptSource(live, {}, "t", join(import.meta.dir, "../../src/server/spec.ts"));
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  writeFileSync(join(dir, "index.ts"), source);
  const spec = (await import(join(dir, "index.ts"))).default as ServerSpec;
  expect((spec.channels[0] as { forum?: unknown }).forum).toEqual({
    tags: [{ name: "Install", emoji: "📦" }, { name: "Solved", moderated: true }],
    requireTag: true,
    reaction: "👍",
    sort: "activity",
    layout: "list",
    threadSlowmode: 30,
  });
  expect(buildPlan({ spec, live, state: new Map(), settings: {}, deletions: false }).ops.every((o) => o.t === "bind")).toBe(true);
});

test("adopt places the bot under the lowest role above it, ties broken by id", async () => {
  const f = new FakeDiscord();
  const first = f.addRole({ name: "First", position: 60 });
  f.addRole({ name: "Second", position: 60 });
  const live = await readLive(f, f.guildId, []);
  // Discord shows the role with the lower id first when positions tie, so Second sits lower.
  expect(first.id < f.roles.find((r) => r.name === "Second")!.id).toBe(true);
  for (const roles of [live.roles, [...live.roles].reverse()]) {
    expect(adoptSource({ ...live, roles }, {}, "t")).toContain('after: "second"');
  }
});

test("adopt keeps the ticket category's channels out of the file", async () => {
  const f = new FakeDiscord();
  const tickets = f.addChannel({ name: "Tickets", type: 4 });
  f.addChannel({ name: "ticket-0001", parent_id: tickets.id });
  const live = await readLive(f, f.guildId, []);
  const source = adoptSource(live, { ticket_category_id: tickets.id }, "t");
  expect(source).not.toContain("ticket-0001");
  expect(source).toContain('others: "keep"');
});
