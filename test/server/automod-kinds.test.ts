import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { applyPlan, planFor } from "../../src/server/apply";
import { defineServer, type ServerSpec, validateSpec } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: import.meta.dir,
    guild: {},
    everyone: { permissions: [] },
    roles: [],
    channels: [],
    automod: [
      { key: "spam", name: "Block Suspected Spam Content", trigger: "spam", block: true },
      { key: "mentions", name: "Block Mention Spam", trigger: "mentions", mentionLimit: 20, raidProtection: true, block: true },
    ],
    posts: [],
    bot: {},
    ...over,
  });

function env(s = spec(), f = new FakeDiscord()) {
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, spec: s, reason: "test" };
}

test("Discord's spam and mention-spam rules are kept like keyword rules", async () => {
  const f = new FakeDiscord();
  f.addRule({ name: "Block Suspected Spam Content", trigger_type: 3, actions: [{ type: 1, metadata: {} }] });
  const e = env(spec(), f);
  const plan = await planFor(e, false);
  expect(plan.ops.map((o) => o.t)).toEqual(["bind", "automod.create"]);
  expect((await applyPlan(e, plan)).failed).toBeNull();
  const mentions = f.rules.find((r) => r.name === "Block Mention Spam")!;
  expect(mentions.trigger_type).toBe(5);
  expect(mentions.trigger_metadata).toEqual({ mention_total_limit: 20, mention_raid_protection_enabled: true });
  expect((await planFor(e, false)).ops).toEqual([]);
  expect((await planFor(e, false)).unmanaged.some((u) => u.includes("Spam"))).toBe(false);
});

test("a spam or mentions rule takes no keywords, and there is one of each at most", () => {
  const bad = spec({
    automod: [
      { key: "a", name: "A", trigger: "spam", keywords: ["x"], block: true },
      { key: "b", name: "B", trigger: "spam", block: true },
    ],
  });
  expect(validateSpec(bad)).toEqual(['automod "a": keywords, regex and allow are for keyword rules', "automod: at most one spam rule"]);
});

test("a mention-spam rule Discord made when Community came on is taken over, not made twice", async () => {
  const f = new FakeDiscord();
  f.onCommunity = () => void f.addRule({ name: "Block Mention Spam", trigger_type: 5, trigger_metadata: { mention_total_limit: 20, mention_raid_protection_enabled: true } });
  const s = spec({
    guild: { verificationLevel: "low", explicitContentFilter: "all", community: { rules: "rules", updates: "staff" } },
    channels: [
      { key: "rules", type: "text", name: "rules" },
      { key: "staff", type: "text", name: "staff" },
    ],
  });
  const e = env(s, f);
  expect((await applyPlan(e, await planFor(e, false))).failed).toBeNull();
  expect(f.rules.filter((r) => r.trigger_type === 5)).toHaveLength(1);
  expect((await planFor(e, false)).ops).toEqual([]);
});
