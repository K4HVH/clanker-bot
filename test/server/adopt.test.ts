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
