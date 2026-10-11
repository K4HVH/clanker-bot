import { expect, test } from "bun:test";
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
  expect(p.manual).toEqual(['2 roles named "Dev": rename one so "dev" can bind']);
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
  expect(p.manual).toEqual(['Role "Dev" is above the bot\'s role: change it by hand, or move the bot\'s role above it']);
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
