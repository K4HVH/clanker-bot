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
  expect(sent.edits).toEqual([{ content: "The server changed since this plan. Run /server plan again.", components: [] }]);
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
