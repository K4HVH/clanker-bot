import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { applyPlan, planFor } from "../../src/server/apply";
import { defineServer, type ServerSpec } from "../../src/server/spec";
import { loadState, stateKey } from "../../src/server/state";
import { FakeDiscord } from "../helpers/fake-discord";

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: `${import.meta.dir}/fixture-assets`,
    guild: { verificationLevel: "low", explicitContentFilter: "all", community: { rules: "rules", updates: "staff" } },
    everyone: { permissions: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
    roles: [
      { key: "developer", name: "Developer", permissions: [] },
      { key: "release-pings", name: "Release pings", permissions: [] },
    ],
    channels: [
      { key: "rules", type: "text", name: "rules" },
      { key: "staff", type: "text", name: "staff" },
      { key: "start-here", type: "text", name: "start-here" },
      { key: "help", type: "forum", name: "help", forum: { tags: [{ name: "Install" }] } },
    ],
    menus: [
      {
        key: "start",
        questions: [
          { key: "why", title: "What brings you here?", multiple: true, options: [{ label: "I write software for it", role: "developer" }] },
          { key: "pings", title: "Pings", multiple: true, options: [{ label: "Releases", description: "A ping for each release", role: "release-pings" }] },
        ],
      },
    ],
    automod: [],
    posts: [
      { key: "read-first", channel: "help", file: "pinned.md", title: "Read this first", pin: true },
      { key: "welcome", channel: "start-here", file: "menu.md", menu: "start" },
    ],
    bot: {},
    ...over,
  });

function env(f = new FakeDiscord()) {
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, reason: "test" };
}

test("a forum post is a pinned thread with its title, and plans clean", async () => {
  const e = env();
  const s = spec();
  const result = await applyPlan({ ...e, spec: s }, await planFor({ ...e, spec: s }, false));
  expect(result.failed).toBeNull();
  const help = e.f.channels.find((c) => c.name === "help")!;
  const thread = e.f.channels.find((c) => c.parent_id === help.id && c.type === 11)!;
  expect(thread.name).toBe("Read this first");
  expect(((thread as unknown as { flags: number }).flags ?? 0) & 2).toBe(2);
  expect(e.f.messages.find((m) => m.channel_id === thread.id)?.content).toBe("## Read this first\n\nSay what you tried.");
  expect((await planFor({ ...e, spec: s }, false)).ops).toEqual([]);
});

test("a forum post's new title renames its thread", async () => {
  const e = env();
  await applyPlan({ ...e, spec: spec() }, await planFor({ ...e, spec: spec() }, false));
  const changed = spec();
  changed.posts[0]!.title = "Before you post";
  const plan = await planFor({ ...e, spec: changed }, false);
  expect(plan.ops.map((o) => o.t)).toEqual(["post.title"]);
  await applyPlan({ ...e, spec: changed }, plan);
  expect(e.f.channels.some((c) => c.type === 11 && c.name === "Before you post")).toBe(true);
});

test("a menu post carries one select per question, naming roles by key", async () => {
  const e = env();
  await applyPlan({ ...e, spec: spec() }, await planFor({ ...e, spec: spec() }, false));
  const start = e.f.channels.find((c) => c.name === "start-here")!;
  const msg = e.f.messages.find((m) => m.channel_id === start.id) as unknown as { components: { components: { custom_id: string; options: { value: string; label: string; description?: string }[]; max_values: number; min_values: number }[] }[] };
  expect(msg.components.map((r) => r.components[0]!.custom_id)).toEqual(["roles:start:why", "roles:start:pings"]);
  expect(msg.components[1]!.components[0]!.options).toEqual([{ label: "Releases", value: "release-pings", description: "A ping for each release" }]);
  expect([msg.components[0]!.components[0]!.min_values, msg.components[0]!.components[0]!.max_values]).toEqual([0, 1]);
});

test("changing a menu edits its post", async () => {
  const e = env();
  await applyPlan({ ...e, spec: spec() }, await planFor({ ...e, spec: spec() }, false));
  const changed = spec();
  changed.menus![0]!.questions[0]!.title = "Why are you here?";
  const plan = await planFor({ ...e, spec: changed }, false);
  expect(plan.ops.map((o) => o.t)).toEqual(["post.edit"]);
  await applyPlan({ ...e, spec: changed }, plan);
  expect((await planFor({ ...e, spec: changed }, false)).ops).toEqual([]);
  expect(loadState(e.db, e.guildId).has(stateKey("post", "welcome#0"))).toBe(true);
});
