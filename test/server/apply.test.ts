import { expect, test } from "bun:test";
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
  expect(plan.manual).toEqual(["Owner: turn on 2FA for moderation (Server Settings > Safety Setup)"]);
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
