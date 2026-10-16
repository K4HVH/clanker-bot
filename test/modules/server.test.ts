import { expect, test } from "bun:test";
import type { AppContext } from "../../src/core/context";
import { applyButton, planCommand } from "../../src/modules/server/index";
import { planFor } from "../../src/server/apply";
import { getSpecName } from "../../src/server/state";
import { FakeDiscord } from "../helpers/fake-discord";
import { silentContext } from "../helpers/fakes";
import fixture from "../server/fixture/index";

interface Sent {
  replies: unknown[];
  edits: unknown[];
}

function interaction(f: FakeDiscord, userId: string, extra: Record<string, unknown> = {}) {
  const sent: Sent = { replies: [], edits: [] };
  const i = {
    guildId: f.guildId,
    guild: { id: f.guildId, ownerId: f.ownerId, name: "Test", client: { users: { fetch: async () => null } }, channels: { cache: new Map(), fetch: async () => null } },
    user: { id: userId, username: "owner" },
    options: { getBoolean: () => null, getString: () => null },
    inGuild: () => true,
    reply: async (o: unknown) => void sent.replies.push(o),
    deferReply: async () => {},
    deferUpdate: async () => {},
    update: async (o: unknown) => void sent.edits.push(o),
    editReply: async (o: unknown) => void sent.edits.push(o),
    followUp: async (o: unknown) => void sent.replies.push(o),
    ...extra,
  };
  return { i: i as never, sent };
}

const deps = (f: FakeDiscord) => ({ api: () => f, specs: { fixture } });

test("only the owner can plan", async () => {
  const f = new FakeDiscord();
  const ctx = silentContext();
  const { i, sent } = interaction(f, "123");
  await planCommand(i, ctx, deps(f));
  expect(sent.replies).toEqual([{ content: "Only the server owner can use /server.", flags: 64 }]);
});

test("a plan made before the server changed is refused without a write", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const { i, sent } = interaction(f, f.ownerId, { customId: `server:apply:${"0".repeat(32)}:0:fixture` });
  await applyButton(i, ctx, deps(f));
  expect(f.writes).toEqual([]);
  expect(sent.edits.at(-1)).toEqual({ content: "The server changed since this plan. Run /server plan again.", components: [] });
});

test("Apply runs the plan it was shown and records the spec", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const { i, sent } = interaction(f, f.ownerId, { customId: `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture` });
  await applyButton(i, ctx, deps(f));
  expect(f.writes.length).toBeGreaterThan(0);
  expect(getSpecName(ctx.db, f.guildId)).toBe("fixture");
  expect(JSON.stringify(sent.edits.at(-1))).toContain(`Applied ${plan.ops.length} changes.`);
  expect((await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false)).ops).toEqual([]);
});

test("a second Apply while one runs is refused, and the work happens once", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const id = `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture`;
  const first = interaction(f, f.ownerId, { customId: id });
  const second = interaction(f, f.ownerId, { customId: id });
  await Promise.all([applyButton(first.i, ctx, deps(f)), applyButton(second.i, ctx, deps(f))]);
  expect(second.sent.replies).toEqual([{ content: "An apply is already running on this server.", flags: 64 }]);
  expect(f.roles.filter((r) => r.name === "Dev")).toHaveLength(1);
  expect(first.sent.edits[0]).toEqual({ content: "Applying...", components: [] });
});

test("a failure during Apply is reported, not lost", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const broken = Object.assign(Object.create(f), { get: async () => { throw new Error("Discord is down"); } });
  const { i, sent } = interaction(f, f.ownerId, { customId: `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture` });
  await applyButton(i, ctx, { api: () => broken, specs: { fixture } });
  expect(sent.edits.at(-1)).toEqual({ content: "Apply failed: Discord is down", components: [] });
});

test("a spec that fails validation is refused before anything is read", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const broken = { ...fixture, bot: { no_such_setting: true } };
  const { i, sent } = interaction(f, f.ownerId);
  await planCommand(i, ctx, { api: () => f, specs: { fixture: broken } });
  expect(sent.replies).toEqual([{ content: 'Spec "fixture" is invalid:\n- bot: unknown setting "no_such_setting"', flags: 64 }]);
});

test("the Apply result lists what's left to do by hand", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const { i, sent } = interaction(f, f.ownerId, { customId: `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture` });
  await applyButton(i, ctx, deps(f));
  const text = JSON.stringify(sent.edits.at(-1));
  expect(text).toContain("Manual steps:");
  expect(text).toContain("Require 2FA for moderator actions");
});

test("a refused write in the Apply result says what to do", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  f.refuse((w) => w.method === "POST" && w.route.endsWith("/roles"), 403, 50013, "Missing Permissions");
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const { i, sent } = interaction(f, f.ownerId, { customId: `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture` });
  await applyButton(i, ctx, deps(f));
  const text = JSON.stringify(sent.edits.at(-1));
  expect(text).toContain("Stopped at");
  expect(text).toContain("give the bot's role Administrator and drag it to the top");
});

test("the Apply result still arrives when Discord no longer takes edits to the reply", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const posted: unknown[] = [];
  const { i } = interaction(f, f.ownerId, {
    customId: `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture`,
    editReply: async () => {
      throw new Error("Invalid Webhook Token");
    },
    channel: { send: async (o: unknown) => void posted.push(o) },
  });
  await applyButton(i, ctx, deps(f));
  expect(JSON.stringify(posted.at(-1))).toContain(`Applied ${plan.ops.length} changes.`);
});

test("an Apply that stops says so in the mod log, with where and why", async () => {
  const f = new FakeDiscord();
  const ctx: AppContext = silentContext();
  ctx.config.set(f.guildId, "mod_log_channel_id", "999");
  const logged: { embeds: { data: { title?: string; description?: string } }[] }[] = [];
  f.refuse((w) => w.method === "POST" && w.route.endsWith("/roles"), 400, 50035, "Invalid Form Body");
  const plan = await planFor({ api: f, db: ctx.db, config: ctx.config, guildId: f.guildId, spec: fixture }, false);
  const { i } = interaction(f, f.ownerId, { customId: `server:apply:${plan.fingerprint.slice(0, 32)}:0:fixture` });
  (i as { guild: { channels: { cache: Map<string, unknown> } } }).guild.channels.cache.set("999", {
    isTextBased: () => true,
    send: async (o: (typeof logged)[number]) => void logged.push(o),
  });
  await applyButton(i, ctx, deps(f));
  const embed = logged.at(-1)!.embeds[0]!.data;
  expect(embed.title).toMatch(/^Server plan stopped after \d+ changes?\.$/);
  expect(embed.description).toStartWith("Stopped at: + role");
  expect(embed.description).toContain("Discord said: Invalid Form Body");
});
