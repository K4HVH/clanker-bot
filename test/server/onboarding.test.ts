import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { adoptSource } from "../../src/server/adopt";
import { type ApplyEnv, applyPlan, planFor } from "../../src/server/apply";
import { readLive } from "../../src/server/live";
import { renderPlan } from "../../src/server/render";
import { type OnboardingSpec, type ServerSpec, validateSpec } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";
import fixture from "./fixture/index";

const onboarding: OnboardingSpec = {
  enabled: true,
  defaultChannels: ["rules"],
  questions: [
    {
      title: "Pings",
      options: [
        { title: "Releases", description: "Each release", roles: ["verified"] },
        { title: "Chat", emoji: "💬", channels: ["general"] },
      ],
    },
  ],
};

function env(spec: ServerSpec = { ...fixture, onboarding }): ApplyEnv & { f: FakeDiscord } {
  const f = new FakeDiscord();
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, spec, reason: "test" };
}

test("onboarding is set from the file, after which the plan is empty", async () => {
  const e = env();
  const plan = await planFor(e, false);
  expect(plan.ops.filter((o) => o.t === "onboarding.set")).toHaveLength(1);
  expect(renderPlan(plan, e.spec)).toContain('"Pings", before joining: Releases (@Verified), Chat (#general)');
  expect((await applyPlan(e, plan)).failed).toBeNull();
  const live = e.f.onboarding;
  expect(live.enabled).toBe(true);
  expect(live.mode).toBe(1);
  expect(live.prompts[0]!.in_onboarding).toBe(true);
  expect(live.prompts[0]!.options.map((o) => o.title)).toEqual(["Releases", "Chat"]);
  expect(live.prompts[0]!.options[1]!.emoji?.name).toBe("💬");
  expect((await planFor(e, false)).ops).toEqual([]);
});

test("a changed answer keeps its id, so members' choices stay with it", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const before = e.f.onboarding.prompts[0]!.options.map((o) => o.id);
  const changed = structuredClone(onboarding);
  changed.questions[0]!.options[0]!.description = "Every release";
  const e2 = { ...e, spec: { ...fixture, onboarding: changed } };
  await applyPlan(e2, await planFor(e2, false));
  expect(e.f.onboarding.prompts[0]!.options.map((o) => o.id)).toEqual(before);
  expect((await planFor(e2, false)).ops).toEqual([]);
});

test("onboarding without Community is a manual step, not a change", async () => {
  const e = env({ ...fixture, guild: { ...fixture.guild, community: false }, onboarding });
  const plan = await planFor(e, false);
  expect(plan.ops.some((o) => o.t === "onboarding.set")).toBe(false);
  expect(plan.manual).toContain("Onboarding needs Community on: turn it on in the file (guild.community)");
});

test("onboarding names roles and channels the file has", () => {
  const bad: OnboardingSpec = { enabled: true, defaultChannels: ["nowhere"], questions: [{ title: "Q", options: [{ title: "A", roles: ["nobody"] }] }] };
  expect(validateSpec({ ...fixture, onboarding: bad })).toEqual([
    'onboarding: unknown channel "nowhere"',
    'onboarding "Q", "A": unknown role "nobody"',
  ]);
  expect(validateSpec({ ...fixture, onboarding: { ...onboarding, questions: [{ title: "Empty", options: [] }] } })).toEqual(['onboarding "Empty": no answers']);
});

test("adopt writes a server's onboarding", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const live = await readLive(e.f, e.f.guildId, []);
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  writeFileSync(join(dir, "index.ts"), adoptSource(live, {}, "t", join(import.meta.dir, "../../src/server/spec.ts")));
  const adopted = (await import(join(dir, "index.ts"))).default as ServerSpec;
  expect(adopted.onboarding).toEqual({
    enabled: true,
    defaultChannels: ["rules"],
    questions: [
      {
        title: "Pings",
        options: [
          { title: "Releases", description: "Each release", roles: ["verified"] },
          { title: "Chat", emoji: "💬", channels: ["general"] },
        ],
      },
    ],
  });
});

test("a new question at the front doesn't take another's id; ids follow titles", async () => {
  const two: OnboardingSpec = {
    enabled: true,
    defaultChannels: ["rules"],
    questions: [
      { title: "X", options: [{ title: "x", roles: ["verified"] }] },
      { title: "Y", options: [{ title: "y", roles: ["mod"] }] },
    ],
  };
  const e = env({ ...fixture, onboarding: two });
  await applyPlan(e, await planFor(e, false));
  const [x, y] = e.f.onboarding.prompts.map((p) => p.id);
  const swapped: OnboardingSpec = { ...two, questions: [{ title: "Z", options: [{ title: "z", roles: ["dev"] }] }, two.questions[0]!] };
  const e2 = { ...e, spec: { ...fixture, onboarding: swapped } };
  await applyPlan(e2, await planFor(e2, false));
  const after = e.f.onboarding.prompts;
  expect(after.map((p) => p.title)).toEqual(["Z", "X"]);
  expect(after[1]!.id).toBe(x!);
  expect(after[0]!.id).not.toBe(y!);
});

test("a server emoji on an answer is set and kept", async () => {
  const custom: OnboardingSpec = { ...onboarding, questions: [{ title: "Pings", options: [{ title: "Releases", emoji: "medius:1234567890", roles: ["verified"] }] }] };
  const e = env({ ...fixture, onboarding: custom });
  await applyPlan(e, await planFor(e, false));
  expect(e.f.onboarding.prompts[0]!.options[0]!.emoji).toEqual({ id: "1234567890", name: "medius", animated: false });
  expect((await planFor(e, false)).ops).toEqual([]);
});

test("onboarding switched off on a server without Community needs nothing", async () => {
  const e = env({ ...fixture, guild: { ...fixture.guild, community: false }, onboarding: { ...onboarding, enabled: false } });
  const plan = await planFor(e, false);
  expect(plan.ops.some((o) => o.t === "onboarding.set")).toBe(false);
  expect(plan.manual).not.toContain("Onboarding needs Community on: turn it on in the file (guild.community)");
});

test("an onboarding answer can't give a role Discord makes", () => {
  const bad: OnboardingSpec = { enabled: true, defaultChannels: ["rules"], questions: [{ title: "Q", options: [{ title: "A", roles: ["everyone"] }] }] };
  expect(validateSpec({ ...fixture, onboarding: bad })).toEqual(['onboarding "Q", "A": role "everyone" is one Discord makes, which onboarding can\'t give']);
});

test("adopt leaves out what onboarding names that it can't key, and says so", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  e.f.onboarding.prompts[0]!.options[0]!.role_ids.push("999999999999999999");
  const live = await readLive(e.f, e.f.guildId, []);
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  const source = adoptSource(live, {}, "t", join(import.meta.dir, "../../src/server/spec.ts"));
  expect(source).toContain("// unknown role 999999999999999999");
  writeFileSync(join(dir, "index.ts"), source);
  const adopted = (await import(join(dir, "index.ts"))).default as ServerSpec;
  expect(validateSpec(adopted)).toEqual([]);
});
