import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { applyPlan, planFor } from "../../src/server/apply";
import { defineServer, type ServerSpec } from "../../src/server/spec";
import { loadState, stateKey } from "../../src/server/state";
import { FakeDiscord } from "../helpers/fake-discord";

const guidelines = `## Before you post\n\n${"Say what you tried. ".repeat(80)}`; // over 1024 characters

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: `${import.meta.dir}/fixture-assets`,
    guild: { verificationLevel: "low", explicitContentFilter: "all", community: { rules: "rules", updates: "staff" } },
    everyone: { permissions: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
    roles: [],
    channels: [
      { key: "rules", type: "text", name: "rules" },
      { key: "staff", type: "text", name: "staff" },
      {
        key: "help",
        type: "forum",
        name: "help",
        topic: guidelines,
        forum: {
          tags: [{ name: "Install", emoji: "📦" }, { name: "Device" }, { name: "Solved", emoji: "✅", moderated: true }],
          requireTag: true,
          reaction: "👍",
          sort: "activity",
          layout: "list",
          threadSlowmode: 30,
        },
      },
    ],
    automod: [],
    posts: [],
    bot: {},
    ...over,
  });

function env(f = new FakeDiscord()) {
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, reason: "test" };
}

test("a forum is created with its tags, settings and long guidelines, then plans clean", async () => {
  const e = env();
  const s = spec();
  const result = await applyPlan({ ...e, spec: s }, await planFor({ ...e, spec: s }, false));
  expect(result.failed).toBeNull();
  const help = e.f.channels.find((c) => c.name === "help")!;
  expect(help.type).toBe(15);
  expect(help.topic).toBe(guidelines);
  expect((help as unknown as { available_tags: { name: string }[] }).available_tags.map((t) => t.name)).toEqual(["Install", "Device", "Solved"]);
  expect((help as unknown as { flags: number }).flags & 16).toBe(16);
  expect((await planFor({ ...e, spec: s }, false)).ops).toEqual([]);
});

test("changing a forum's tags keeps the ids of tags it already has", async () => {
  const e = env();
  const s = spec();
  await applyPlan({ ...e, spec: s }, await planFor({ ...e, spec: s }, false));
  const help = e.f.channels.find((c) => c.name === "help") as unknown as { available_tags: { id: string; name: string }[] };
  const installId = help.available_tags.find((t) => t.name === "Install")!.id;
  const changed = spec();
  const forum = changed.channels[2] as { forum: { tags: { name: string }[] } };
  forum.forum.tags = [{ name: "Install" }, { name: "Windows" }];
  const plan = await planFor({ ...e, spec: changed }, false);
  expect(plan.ops.map((o) => o.t)).toEqual(["channel.update"]);
  await applyPlan({ ...e, spec: changed }, plan);
  const after = (e.f.channels.find((c) => c.name === "help") as unknown as { available_tags: { id: string; name: string }[] }).available_tags;
  expect(after.find((t) => t.name === "Install")?.id).toBe(installId);
  expect(after.map((t) => t.name)).toEqual(["Install", "Windows"]);
});

test("a text channel becomes an announcement channel in place once Community is on", async () => {
  const e = env();
  const old = e.f.addChannel({ name: "changelog" });
  const s = spec({
    channels: [
      { key: "rules", type: "text", name: "rules" },
      { key: "staff", type: "text", name: "staff" },
      { key: "releases", type: "announcement", name: "releases", was: ["changelog"] },
    ],
  });
  const plan = await planFor({ ...e, spec: s }, false);
  expect(plan.ops.find((o) => o.t === "bind" && o.key === "releases")).toMatchObject({ id: old.id });
  const result = await applyPlan({ ...e, spec: s }, plan);
  expect(result.failed).toBeNull();
  const after = e.f.channels.find((c) => c.id === old.id)!;
  expect([after.type, after.name]).toEqual([5, "releases"]);
  expect(loadState(e.db, e.guildId).get(stateKey("channel", "releases"))).toBe(old.id);
  expect((await planFor({ ...e, spec: s }, false)).ops).toEqual([]);
});

test("an invite background is set where the server's boost level allows it, and a manual step says why where not", async () => {
  const e = env();
  const s = spec({ guild: { ...spec().guild, splash: "icon.png" } });
  expect((await planFor({ ...e, spec: s }, false)).manual).toContain(
    "The invite background needs boost level 1 (2 boosts): it's applied once the server has it",
  );
  e.f.guild.features = ["INVITE_SPLASH"];
  const plan = await planFor({ ...e, spec: s }, false);
  expect(plan.ops.find((o) => o.t === "asset.set")).toMatchObject({ key: "splash", file: "icon.png" });
});
