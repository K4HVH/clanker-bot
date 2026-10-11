import { describe, expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { type ApplyEnv, applyPlan, planFor } from "../../src/server/apply";
import { loadState, putState, stateKey } from "../../src/server/state";
import { FakeDiscord } from "../helpers/fake-discord";
import fixture from "./fixture/index";

function env(f = new FakeDiscord()): ApplyEnv & { f: FakeDiscord } {
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, spec: fixture, reason: "test" };
}

test("an empty server is built to the spec, after which the plan is empty", async () => {
  const e = env();
  const plan = await planFor(e, false);
  expect(plan.manual).toEqual(["Owner: turn on 2FA for moderation in Server Settings > Safety Setup > Permissions > Require 2FA for moderator actions. Your account needs 2FA first: User Settings > My Account > Enable Authenticator App"]);
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
