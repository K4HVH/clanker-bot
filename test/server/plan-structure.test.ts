import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { readLive } from "../../src/server/live";
import { buildPlan, type Op } from "../../src/server/plan";
import { defineServer, type ServerSpec } from "../../src/server/spec";
import { type State, stateKey } from "../../src/server/state";
import { FakeDiscord } from "../helpers/fake-discord";

const V = PermissionFlagsBits.ViewChannel;
const S = PermissionFlagsBits.SendMessages;

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: import.meta.dir,
    guild: {},
    everyone: { permissions: [] },
    roles: [{ key: "dev", name: "Dev", permissions: ["Administrator"] }],
    channels: [{ key: "general", type: "text", name: "general" }],
    automod: [],
    posts: [],
    bot: {},
    ...over,
  });

const plan = async (f: FakeDiscord, s: ServerSpec, state: State = new Map(), deletions = false) =>
  buildPlan({ spec: s, live: await readLive(f, f.guildId, []), state, settings: {}, deletions });

const kinds = (ops: Op[]) => ops.map((o) => o.t);

test("binds existing objects by name", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const general = f.addChannel({ name: "general" });
  const p = await plan(f, spec());
  expect(p.ops).toEqual([
    { t: "bind", kind: "role", key: "dev", id: dev.id, label: 'role "Dev"' },
    { t: "bind", kind: "channel", key: "general", id: general.id, label: "#general" },
  ]);
  expect(p.manual).toEqual([]);
});

test("two objects with one name stop that key and what references it", async () => {
  const f = new FakeDiscord();
  f.addRole({ name: "Dev", position: 3 });
  f.addRole({ name: "Dev", position: 4 });
  f.addChannel({ name: "general" });
  const p = await plan(f, spec({ channels: [{ key: "general", type: "text", name: "general", overwrites: { dev: { ViewChannel: true } } }] }));
  expect(p.manual).toEqual(['2 roles named "Dev": rename one in Discord so "dev" can bind to the other, then plan again']);
  expect(p.ops.filter((o) => o.t !== "bind")).toEqual([]);
});

test("creates what doesn't exist", async () => {
  const f = new FakeDiscord();
  const p = await plan(f, spec());
  expect(kinds(p.ops)).toEqual(["role.create", "channel.create"]);
  const create = p.ops.find((o) => o.t === "role.create");
  expect(create).toMatchObject({ key: "dev", name: "Dev", permissions: PermissionFlagsBits.Administrator });
});

test("a renamed object in state is an update", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const general = f.addChannel({ name: "general" });
  const state: State = new Map([[stateKey("role", "dev"), dev.id], [stateKey("channel", "general"), general.id]]);
  const p = await plan(f, spec({ roles: [{ key: "dev", name: "Developers", permissions: ["Administrator"] }] }), state);
  expect(p.ops).toEqual([{ t: "role.update", key: "dev", changes: [{ field: "name", from: "Dev", to: "Developers" }], flags: [] }]);
});

test("a role gaining a permission is flagged", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: "0", position: 3 });
  const p = await plan(f, spec({ channels: [] }), new Map([[stateKey("role", "dev"), dev.id]]));
  expect(p.ops[0]).toMatchObject({ t: "role.update", flags: ["widens"] });
});

test("a role above the bot is a manual step", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: "0", position: 60 });
  const p = await plan(f, spec({ channels: [] }), new Map([[stateKey("role", "dev"), dev.id]]));
  expect(p.ops).toEqual([]);
  expect(p.manual).toEqual([
    `Role "Dev" is above the bot's role, so the bot can't change it. Drag the bot's role above it in Server Settings > Roles and plan again, or change it there by hand: permissions +Administrator`,
  ]);
});

test("removing a view deny is flagged, as is a new allow", async () => {
  const f = new FakeDiscord();
  const general = f.addChannel({ name: "general", permission_overwrites: [{ id: f.guildId, type: 0, allow: "0", deny: String(V) }] });
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const state: State = new Map([[stateKey("channel", "general"), general.id], [stateKey("role", "dev"), dev.id]]);
  const p = await plan(f, spec({ channels: [{ key: "general", type: "text", name: "general", overwrites: { dev: { SendMessages: true } } }] }), state);
  expect(p.ops).toEqual([
    { t: "overwrite.set", channel: "general", target: "dev", allow: S, deny: 0n, before: null, flags: ["widens"] },
    { t: "overwrite.delete", channel: "general", target: "everyone", before: { allow: 0n, deny: V }, flags: ["widens"] },
  ]);
});

test("member overwrites stay unless the channel claims them", async () => {
  const f = new FakeDiscord();
  const general = f.addChannel({ name: "general", permission_overwrites: [{ id: "4242", type: 1, allow: String(V), deny: "0" }] });
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const state: State = new Map([[stateKey("channel", "general"), general.id], [stateKey("role", "dev"), dev.id]]);
  const kept = await plan(f, spec(), state);
  expect(kept.ops).toEqual([]);
  expect(kept.unmanaged).toContain("#general: permissions for member 4242");
  const claimed = await plan(f, spec({ channels: [{ key: "general", type: "text", name: "general", members: "managed" }] }), state);
  expect(claimed.ops).toEqual([{ t: "overwrite.delete", channel: "general", target: "member:4242", before: { allow: V, deny: 0n }, flags: [] }]);
});

test("deletions are held unless asked for", async () => {
  const f = new FakeDiscord();
  const old = f.addChannel({ name: "old" });
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const general = f.addChannel({ name: "general" });
  const state: State = new Map([[stateKey("channel", "old"), old.id], [stateKey("channel", "general"), general.id], [stateKey("role", "dev"), dev.id]]);
  const held = await plan(f, spec(), state);
  expect(held.ops).toEqual([]);
  expect(held.held).toEqual([{ t: "channel.delete", key: "old", name: "old", flags: ["deletes"] }]);
  const asked = await plan(f, spec(), state, true);
  expect(asked.ops).toEqual([{ t: "channel.delete", key: "old", name: "old", flags: ["deletes"] }]);
  expect(asked.held).toEqual([]);
});

test("created objects are ordered with their siblings", async () => {
  const f = new FakeDiscord();
  const p = await plan(f, spec({
    roles: [{ key: "dev", name: "Dev", permissions: [] }, { key: "mod", name: "Mod", permissions: [] }],
    channels: [{ key: "a", type: "text", name: "a" }, { key: "b", type: "text", name: "b" }],
  }));
  expect(kinds(p.ops)).toEqual(["role.create", "role.create", "role.order", "channel.create", "channel.create", "channel.order"]);
  expect(p.ops.find((o) => o.t === "role.order")).toEqual({ t: "role.order", keys: ["dev", "mod"] });
});

test("a reorder is one order op", async () => {
  const f = new FakeDiscord();
  const a = f.addChannel({ name: "a", position: 0 });
  const b = f.addChannel({ name: "b", position: 1 });
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const state: State = new Map([[stateKey("channel", "a"), a.id], [stateKey("channel", "b"), b.id], [stateKey("role", "dev"), dev.id]]);
  const p = await plan(f, spec({ channels: [{ key: "b", type: "text", name: "b" }, { key: "a", type: "text", name: "a" }] }), state);
  expect(p.ops).toEqual([{ t: "channel.order", items: [{ key: "b", parent: null }, { key: "a", parent: null }] }]);
});

test("a server matching its spec plans nothing", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const general = f.addChannel({ name: "general" });
  const state: State = new Map([[stateKey("role", "dev"), dev.id], [stateKey("channel", "general"), general.id]]);
  const p = await plan(f, spec(), state);
  expect(p.ops).toEqual([]);
  expect(p.held).toEqual([]);
  expect(p.manual).toEqual([]);
});

test("unclaimed roles and channels are listed unmanaged", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const general = f.addChannel({ name: "general" });
  f.addRole({ name: "Cool People", position: 2 });
  f.addChannel({ name: "abcurves" });
  const state: State = new Map([[stateKey("role", "dev"), dev.id], [stateKey("channel", "general"), general.id]]);
  const p = await plan(f, spec(), state);
  expect(p.unmanaged).toEqual(['role "Cool People"', "#abcurves"]);
});

test("permission bits with no name are kept, never planned away", async () => {
  const OLD = 1n << 47n; // a bit Discord still reports that discord.js no longer names
  const f = new FakeDiscord();
  f.roles.find((r) => r.id === f.guildId)!.permissions = String(OLD | PermissionFlagsBits.ReadMessageHistory);
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const general = f.addChannel({ name: "general", permission_overwrites: [{ id: f.guildId, type: 0, allow: String(OLD), deny: "0" }] });
  const state: State = new Map([[stateKey("role", "dev"), dev.id], [stateKey("channel", "general"), general.id]]);
  const same = await plan(f, spec({ everyone: { permissions: ["ReadMessageHistory"] }, channels: [{ key: "general", type: "text", name: "general", overwrites: { everyone: {} } }] }), state);
  expect(same.ops).toEqual([]);
  const changed = await plan(f, spec({ everyone: { permissions: [] }, channels: [{ key: "general", type: "text", name: "general", overwrites: { everyone: { ViewChannel: false } } }] }), state);
  expect(changed.ops).toEqual([
    { t: "role.update", key: "everyone", changes: [{ field: "permissions", from: OLD | PermissionFlagsBits.ReadMessageHistory, to: OLD }], flags: [] },
    { t: "overwrite.set", channel: "general", target: "everyone", allow: OLD, deny: V, before: { allow: OLD, deny: 0n }, flags: [] },
  ]);
});

test("an order op names only the groups that move", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
  const a = f.addChannel({ name: "a", position: 0 });
  const cat = f.addChannel({ name: "Cat", type: 4, position: 1 });
  const x = f.addChannel({ name: "x", parent_id: cat.id, position: 0 });
  const y = f.addChannel({ name: "y", parent_id: cat.id, position: 1 });
  const state: State = new Map([
    [stateKey("role", "dev"), dev.id],
    [stateKey("channel", "a"), a.id],
    [stateKey("channel", "cat"), cat.id],
    [stateKey("channel", "x"), x.id],
    [stateKey("channel", "y"), y.id],
  ]);
  const p = await plan(f, spec({
    channels: [
      { key: "b", type: "text", name: "b" },
      { key: "a", type: "text", name: "a" },
      { key: "cat", type: "category", name: "Cat", channels: [{ key: "x", type: "text", name: "x" }, { key: "y", type: "text", name: "y" }] },
    ],
  }), state);
  expect(p.ops.find((o) => o.t === "channel.order")).toEqual({ t: "channel.order", items: [{ key: "b", parent: null }, { key: "a", parent: null }] });
});

describe("new channels and who can see them", () => {
  const roles: ServerSpec["roles"] = [
    { key: "dev", name: "Dev", permissions: ["Administrator"] },
    { key: "verified", name: "Verified", permissions: ["ViewChannel", "SendMessages"] },
  ];
  const admin = (children: ServerSpec["channels"][number][]) =>
    ({ key: "admin", type: "category", name: "Admin", overwrites: { everyone: { ViewChannel: false } }, channels: children }) as ServerSpec["channels"][number];

  test("a channel without its own permissions takes its category's, so a staff channel stays hidden", async () => {
    const f = new FakeDiscord();
    const p = await plan(f, spec({ roles, channels: [admin([{ key: "mod-chat", type: "text", name: "mod-chat" }])] }));
    const create = p.ops.find((o) => o.t === "channel.create" && o.key === "mod-chat");
    expect(create).toMatchObject({ overwrites: [{ target: "everyone", allow: 0n, deny: V }], visibleTo: [], flags: [] });
  });

  test("a channel any non-admin role can see is flagged, naming the roles", async () => {
    const f = new FakeDiscord();
    const p = await plan(f, spec({ roles, channels: [{ key: "open", type: "text", name: "open" }] }));
    expect(p.ops.find((o) => o.t === "channel.create")).toMatchObject({ visibleTo: ["verified"], flags: ["widens"] });
  });

  test("explicitly empty permissions mean none, not the category's", async () => {
    const f = new FakeDiscord();
    const p = await plan(f, spec({ roles, channels: [admin([{ key: "lobby", type: "text", name: "lobby", overwrites: {} }])] }));
    expect(p.ops.find((o) => o.t === "channel.create" && o.key === "lobby")).toMatchObject({ overwrites: [], visibleTo: ["verified"], flags: ["widens"] });
  });
});

describe("former names and pruning", () => {
  test("a channel and a role bind by a former name, and are renamed", async () => {
    const f = new FakeDiscord();
    const role = f.addRole({ name: "Donators", position: 3 });
    const old = f.addChannel({ name: "📝-changelog" });
    const p = await plan(f, spec({
      roles: [{ key: "supporters", name: "Supporters", was: ["Donators"], permissions: [] }],
      channels: [{ key: "changelog", type: "text", name: "changelog", was: ["📝-changelog"] }],
    }));
    expect(p.ops).toEqual([
      { t: "bind", kind: "role", key: "supporters", id: role.id, label: 'role "Donators"' },
      { t: "bind", kind: "channel", key: "changelog", id: old.id, label: "#📝-changelog" },
      { t: "role.update", key: "supporters", changes: [{ field: "name", from: "Donators", to: "Supporters" }], flags: [] },
      { t: "channel.update", key: "changelog", changes: [{ field: "name", from: "📝-changelog", to: "changelog" }], flags: [] },
    ]);
  });

  test("the current name wins over a former one", async () => {
    const f = new FakeDiscord();
    f.addChannel({ name: "old" });
    const now = f.addChannel({ name: "new" });
    const p = await plan(f, spec({ roles: [], channels: [{ key: "c", type: "text", name: "new", was: ["old"] }] }));
    expect(p.ops[0]).toMatchObject({ t: "bind", id: now.id });
  });

  test("prune deletes what the spec doesn't name, flagged; without it they're only listed", async () => {
    const f = new FakeDiscord();
    const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3 });
    const general = f.addChannel({ name: "general" });
    const extraRole = f.addRole({ name: "Extra", position: 2 });
    const cat = f.addChannel({ name: "Text Channels", type: 4 });
    const inCat = f.addChannel({ name: "random", parent_id: cat.id });
    const state: State = new Map([[stateKey("role", "dev"), dev.id], [stateKey("channel", "general"), general.id]]);
    const listed = await plan(f, spec(), state);
    expect(listed.ops).toEqual([]);
    const pruned = buildPlan({ spec: spec(), live: await readLive(f, f.guildId, []), state, settings: {}, deletions: false, prune: true });
    expect(pruned.ops).toEqual([
      { t: "prune", kind: "channel", id: inCat.id, label: "#random", flags: ["deletes"] },
      { t: "prune", kind: "channel", id: cat.id, label: 'category "Text Channels"', flags: ["deletes"] },
      { t: "prune", kind: "role", id: extraRole.id, label: 'role "Extra"', flags: ["deletes"] },
    ]);
    expect(pruned.unmanaged).toEqual([]);
  });
});

test("a role the bot can't change says what to change by hand, and where", async () => {
  const f = new FakeDiscord();
  const dev = f.addRole({ name: "Dev", permissions: "0", position: 60, color: 5 });
  const p = await plan(f, spec({ channels: [] }), new Map([[stateKey("role", "dev"), dev.id]]));
  expect(p.manual).toEqual([
    `Role "Dev" is above the bot's role, so the bot can't change it. Drag the bot's role above it in Server Settings > Roles and plan again, or change it there by hand: colour 5 -> 0; permissions +Administrator`,
  ]);
});
