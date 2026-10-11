import { describe, expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { type ApplyEnv, applyPlan, planFor } from "../../src/server/apply";
import { loadState, putState, stateKey } from "../../src/server/state";
import { defineServer } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";
import fixture from "./fixture/index";

function env(f = new FakeDiscord()): ApplyEnv & { f: FakeDiscord } {
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, spec: fixture, reason: "test" };
}

test("an empty server is built to the spec, after which the plan is empty", async () => {
  const e = env();
  const plan = await planFor(e, false);
  expect(plan.manual).toEqual(["Owner: turn on 2FA for moderation in Server Settings > Safety Setup > Permissions > Require 2FA for moderator actions. First turn on 2FA (User Settings > My Account > Enable Authenticator App) for your account and for the account that owns the bot's application: without it the bot can't give roles, kick or ban once this is on"]);
  const result = await applyPlan(e, plan);
  expect(result).toEqual({ done: plan.ops.length, failed: null, remaining: 0 });
  const again = await planFor(e, false);
  expect(again.ops).toEqual([]);
  expect(e.f.guild.features).toContain("COMMUNITY");
  expect(e.f.writes.every((w) => w.reason === "test")).toBe(true);
});

test("an overwrite names a role created earlier in the same run", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const state = loadState(e.db, e.guildId);
  const general = e.f.channels.find((c) => c.id === state.get(stateKey("channel", "general")))!;
  expect(general.permission_overwrites.map((o) => o.id)).toContain(state.get(stateKey("role", "verified"))!);
});

test("a refused write stops the run, and the next plan finishes it", async () => {
  const e = env();
  let writes = 0;
  e.f.refuse(() => ++writes === 3);
  const first = await applyPlan(e, await planFor(e, false));
  expect(first.done).toBe(2);
  expect(first.failed?.op.t).toBe("role.create");
  expect(first.failed?.error).toContain("refused");
  e.f.allowAll();
  const second = await applyPlan(e, await planFor(e, false));
  expect(second.failed).toBeNull();
  expect((await planFor(e, false)).ops).toEqual([]);
  expect(e.f.roles.filter((r) => r.name === "Dev")).toHaveLength(1);
});

test("held deletions never run", async () => {
  const e = env();
  const old = e.f.addChannel({ name: "old" });
  putState(e.db, e.guildId, "channel", "old", old.id);
  const plan = await planFor(e, false);
  expect(plan.held.map((o) => o.t)).toEqual(["channel.delete"]);
  await applyPlan(e, plan);
  expect(e.f.channels.some((c) => c.id === old.id)).toBe(true);
  await applyPlan(e, await planFor(e, true));
  expect(e.f.channels.some((c) => c.id === old.id)).toBe(false);
  expect(loadState(e.db, e.guildId).has(stateKey("channel", "old"))).toBe(false);
});

test("a channel setting stores the id of the channel it names", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const state = loadState(e.db, e.guildId);
  expect(e.config.get<string>(e.guildId, "mod_log_channel_id")).toBe(state.get(stateKey("channel", "logs")));
  expect(e.config.get<string>(e.guildId, "verified_role_id")).toBe(state.get(stateKey("role", "verified")));
});

test("an announcement channel is created once Community is on", async () => {
  const e = env();
  const spec = { ...fixture, channels: [...fixture.channels, { key: "news", type: "announcement" as const, name: "news" }] };
  const plan = await planFor({ ...e, spec }, false);
  const result = await applyPlan({ ...e, spec }, plan);
  expect(result.failed).toBeNull();
  expect(e.f.channels.some((c) => c.name === "news" && c.type === 5)).toBe(true);
});

test("a server nobody has boosted applies a spec that names the booster role", async () => {
  const e = env();
  const spec = {
    ...fixture,
    channels: [{ key: "perks", type: "text" as const, name: "perks", overwrites: { booster: { ViewChannel: true } } }, ...fixture.channels],
    automod: fixture.automod.map((r) => ({ ...r, exemptRoles: [...(r.exemptRoles ?? []), "booster"] })),
    bot: { ...fixture.bot, ticket_check_exempt_roles: { roles: ["booster"] } },
  };
  const plan = await planFor({ ...e, spec }, false);
  expect(plan.manual).toContain('This server has no Server Booster role, so what names "booster" waits until someone boosts. Nothing to do');
  expect(plan.ops.find((o) => o.t === "automod.create")).toMatchObject({ body: { exemptRoles: ["dev"] } });
  expect(plan.ops.some((o) => o.t === "setting.set" && o.key === "ticket_check_exempt_roles")).toBe(false);
  expect((await applyPlan({ ...e, spec }, plan)).failed).toBeNull();
});

test("renaming a key in the file moves the object to the new key", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const id = loadState(e.db, e.guildId).get(stateKey("channel", "general"))!;
  const renamed = {
    ...fixture,
    channels: fixture.channels.map((c) =>
      c.type === "category" ? { ...c, channels: c.channels.map((ch) => (ch.key === "general" ? { ...ch, key: "chat" } : ch)) } : c,
    ),
  };
  const plan = await planFor({ ...e, spec: renamed }, false);
  expect(plan.ops).toEqual([{ t: "bind", kind: "channel", key: "chat", id, label: "#general", replaces: "general" }]);
  expect(plan.held).toEqual([]);
  await applyPlan({ ...e, spec: renamed }, plan);
  const state = loadState(e.db, e.guildId);
  expect(state.get(stateKey("channel", "chat"))).toBe(id);
  expect(state.has(stateKey("channel", "general"))).toBe(false);
  expect((await planFor({ ...e, spec: renamed }, false)).ops).toEqual([]);
});

test("prune clears what the spec doesn't name, and stays clear", async () => {
  const e = env();
  const cat = e.f.addChannel({ name: "Text Channels", type: 4 });
  e.f.addChannel({ name: "chat", parent_id: cat.id });
  e.f.addRole({ name: "Extra", position: 2 });
  await applyPlan(e, await planFor(e, false, true));
  expect(e.f.channels.some((c) => c.name === "Text Channels" || c.name === "chat")).toBe(false);
  expect(e.f.roles.some((r) => r.name === "Extra")).toBe(false);
  expect((await planFor(e, false, true)).ops).toEqual([]);
});

describe("what Apply can't do comes with instructions", () => {
  test("a write Discord refuses for want of a permission says how to fix it", async () => {
    const e = env();
    e.f.refuse((w) => w.method === "POST" && w.route.endsWith("/roles"), 403, 50013, "Missing Permissions");
    const result = await applyPlan(e, await planFor(e, false));
    expect(result.failed?.error).toBe("Missing Permissions");
    expect(result.failed?.hint).toBe(
      "The bot lacks a permission for this. In Server Settings > Roles, give the bot's role Administrator and drag it to the top, then plan again.",
    );
  });

  test("any other refusal says to plan again, then what to do by hand", async () => {
    const e = env();
    e.f.refuse((w) => w.method === "POST" && w.route.endsWith("/roles"), 400, 50035, "Invalid Form Body");
    const result = await applyPlan(e, await planFor(e, false));
    expect(result.failed?.hint).toBe('Discord refused a value from the spec. Check it, then plan again. Or do it by hand: + role "Dev": Administrator');
  });
});

describe("a category's overwrite changes", () => {
  // Discord copies a category's overwrite edits onto each child whose overwrites match the category's.
  const deny = String(1n << 11n); // Send Messages
  const setup = () => {
    const f = new FakeDiscord();
    const verified = f.addRole({ name: "Verified", position: 2 });
    const ow = () => [{ id: verified.id, type: 0 as const, allow: "0", deny }];
    const cat = f.addChannel({ name: "cat", type: 4, permission_overwrites: ow() });
    const news = f.addChannel({ name: "news", parent_id: cat.id, permission_overwrites: ow() });
    const chat = f.addChannel({ name: "chat", parent_id: cat.id, permission_overwrites: ow() });
    const spec = defineServer({
      name: "t",
      dir: import.meta.dir,
      guild: {},
      everyone: { permissions: [] },
      roles: [{ key: "verified", name: "Verified", permissions: [] }],
      channels: [
        {
          key: "cat",
          type: "category",
          name: "cat",
          channels: [
            { key: "news", type: "text", name: "news", overwrites: { verified: { SendMessages: false } } },
            { key: "chat", type: "text", name: "chat" },
            { key: "fresh", type: "text", name: "fresh", overwrites: { verified: { SendMessages: false } } },
          ],
        },
      ],
      automod: [],
      posts: [],
      bot: {},
    });
    return { e: { ...env(f), spec }, f, ow, news, chat };
  };

  test("reach a child that matched it, which then keeps what the file gives it", async () => {
    const { e, f, ow, news, chat } = setup();
    expect((await applyPlan(e, await planFor(e, false))).failed).toBeNull();
    expect((await planFor(e, false)).ops).toEqual([]);
    expect(news.permission_overwrites).toEqual(ow());
    expect(chat.permission_overwrites).toEqual([]);
    expect(f.channels.find((c) => c.name === "fresh")!.permission_overwrites).toEqual(ow());
  });
});

describe("a category's overwrites edited one at a time", () => {
  const S = String(1n << 11n); // Send Messages
  const base = (f: FakeDiscord, channels: Parameters<typeof defineServer>[0]["channels"], roles = [{ key: "verified", name: "Verified", permissions: [] as [] }]) => {
    const spec = defineServer({ name: "t", dir: import.meta.dir, guild: {}, everyone: { permissions: [] }, roles, channels, automod: [], posts: [], bot: {} });
    return { ...env(f), spec };
  };

  test("a new announcement channel is made after the edits, with what the file gives it", async () => {
    const f = new FakeDiscord();
    (f.guild.features as string[]).push("COMMUNITY");
    const verified = f.addRole({ name: "Verified", position: 2 });
    const ow = () => [{ id: verified.id, type: 0 as const, allow: "0", deny: S }];
    f.addChannel({ name: "cat", type: 4, permission_overwrites: ow() });
    const e = base(f, [
      { key: "cat", type: "category", name: "cat", channels: [{ key: "notice", type: "announcement", name: "notice", overwrites: { verified: { SendMessages: false } } }] },
    ]);
    expect((await applyPlan(e, await planFor(e, false))).failed).toBeNull();
    expect((await planFor(e, false)).ops).toEqual([]);
    expect(f.channels.find((c) => c.name === "notice")!.permission_overwrites).toEqual(ow());
  });

  test("a child matching the category part way through follows the edits after that", async () => {
    const f = new FakeDiscord();
    const verified = f.addRole({ name: "Verified", position: 2 });
    const dev = f.addRole({ name: "Dev", position: 3 });
    const v = { id: verified.id, type: 0 as const, allow: "0", deny: S };
    const d = { id: dev.id, type: 0 as const, allow: S, deny: "0" };
    f.addChannel({ name: "cat", type: 4, permission_overwrites: [v] });
    const child = f.addChannel({ name: "child", parent_id: f.channels.find((c) => c.name === "cat")!.id, permission_overwrites: [v, d] });
    const e = base(
      f,
      [
        {
          key: "cat",
          type: "category",
          name: "cat",
          overwrites: { verified: { SendMessages: false }, dev: { SendMessages: true }, everyone: { AddReactions: false } },
          channels: [{ key: "child", type: "text", name: "child", overwrites: { verified: { SendMessages: false }, dev: { SendMessages: true } } }],
        },
      ],
      [
        { key: "dev", name: "Dev", permissions: [] },
        { key: "verified", name: "Verified", permissions: [] },
      ],
    );
    expect((await applyPlan(e, await planFor(e, false))).failed).toBeNull();
    expect((await planFor(e, false)).ops).toEqual([]);
    expect(child.permission_overwrites).toEqual([v, d]);
  });
});

test("moving Community's updates channel sends the feature list, which Discord needs to take it", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const updates = e.spec.guild.community && e.spec.guild.community.updates;
  const moved = { ...e.spec, guild: { ...e.spec.guild, community: { rules: "rules", updates: "general" } } };
  const e2 = { ...e, spec: moved };
  expect((await applyPlan(e2, await planFor(e2, false))).failed).toBeNull();
  expect((await planFor(e2, false)).ops).toEqual([]);
  expect(e.f.guild.public_updates_channel_id).toBe(loadState(e.db, e.guildId).get(stateKey("channel", "general")));
  expect(updates).toBe("staff-updates");
});

test("prune and the unmanaged list leave alone what sits in a category that keeps others", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const spec = { ...e.spec, channels: [...e.spec.channels, { key: "tickets", type: "category" as const, name: "Tickets", others: "keep" as const, channels: [] }] };
  const e2 = { ...e, spec };
  await applyPlan(e2, await planFor(e2, false));
  const tickets = e.f.channels.find((c) => c.name === "Tickets")!;
  e.f.addChannel({ name: "ticket-0001", parent_id: tickets.id });
  const plan = await planFor(e2, false, true);
  expect(plan.ops).toEqual([]);
  expect(plan.unmanaged.some((u) => u.includes("ticket-0001"))).toBe(false);
});

test("a forum on a server turning Community on is made after it", async () => {
  const e = env();
  const spec = {
    ...e.spec,
    channels: [...e.spec.channels, { key: "board", type: "forum" as const, name: "board" }],
  };
  const e2 = { ...e, spec };
  const result = await applyPlan(e2, await planFor(e2, false));
  expect(result.failed).toBeNull();
  expect(e.f.channels.some((c) => c.name === "board" && c.type === 15)).toBe(true);
});

test("a role's widened permissions wait until the channels' overwrites are set", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const spec = {
    ...e.spec,
    roles: e.spec.roles.map((r) => (r.key === "verified" ? { ...r, permissions: [...r.permissions, "AttachFiles" as const] } : r)),
    channels: e.spec.channels.map((c) => (c.key === "rules" && c.type === "text" ? { ...c, overwrites: { everyone: { ViewChannel: true, SendMessages: false, AttachFiles: false } } } : c)),
  };
  const e2 = { ...e, spec };
  e.f.refuse((w) => w.method === "PUT" && w.route.includes("/permissions/"));
  await applyPlan(e2, await planFor(e2, false));
  const verified = e.f.roles.find((r) => r.name === "Verified")!;
  expect(BigInt(verified.permissions) & (1n << 15n)).toBe(0n);
});

test("a role given to the members already here goes to each of them once, and not to bots", async () => {
  const e = env();
  const roles = [...e.spec.roles, { key: "pings", name: "Pings", grantToExisting: true, permissions: [] }];
  const e2 = { ...e, spec: { ...e.spec, roles } };
  e.f.members.push({ user: { id: "1001" }, roles: [] }, { user: { id: "1002", bot: true }, roles: [] }, { user: { id: "1003" }, roles: [] });
  const plan = await planFor(e2, false);
  expect(plan.ops.filter((o) => o.t === "role.grant")).toEqual([{ t: "role.grant", key: "pings" }]);
  expect((await applyPlan(e2, plan)).failed).toBeNull();
  const pings = e.f.roles.find((r) => r.name === "Pings")!.id;
  expect(e.f.members.filter((m) => m.roles.includes(pings)).map((m) => m.user.id)).toEqual(["1001", "1003"]);
  e.f.members.push({ user: { id: "1004" }, roles: [] });
  expect((await planFor(e2, false)).ops).toEqual([]);
});

test("a post taken out of the file is deleted with the deletions", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const e2 = { ...e, spec: { ...e.spec, posts: [] } };
  const held = await planFor(e2, false);
  expect(held.held.map((o) => o.t)).toEqual(["post.delete"]);
  await applyPlan(e2, await planFor(e2, true));
  expect(e.f.messages.some((m) => m.content.includes("Rule"))).toBe(false);
  expect((await planFor(e2, true)).ops).toEqual([]);
});

test("a text setting names a channel by key, stored as the channel's mention", async () => {
  const e = env();
  const e2 = { ...e, spec: { ...e.spec, bot: { ...e.spec.bot, ticket_check_fail_text: "Ask in {#general}." } } };
  await applyPlan(e2, await planFor(e2, false));
  const general = loadState(e.db, e.guildId).get(stateKey("channel", "general"));
  expect(e.config.get<string>(e.guildId, "ticket_check_fail_text")).toBe(`Ask in <#${general}>.`);
  expect((await planFor(e2, false)).ops).toEqual([]);
});
