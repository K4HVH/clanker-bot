import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { applyPlan, planFor } from "../../src/server/apply";
import { embedPost } from "../../src/server/posts";
import { renderPlan } from "../../src/server/render";
import { defineServer, type ServerSpec, validateSpec } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";

const BLUE = 0x0080ff;

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: `${import.meta.dir}/fixture-assets`,
    guild: {},
    everyone: { permissions: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
    roles: [],
    channels: [
      { key: "rules", type: "text", name: "rules" },
      { key: "help", type: "text", name: "help" },
    ],
    automod: [],
    posts: [{ key: "rules", channel: "rules", file: "embed.md", embed: { color: BLUE } }],
    bot: {},
    ...over,
  });

function env() {
  const f = new FakeDiscord();
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, reason: "test" };
}

const apply = async (e: ReturnType<typeof env>, s: ServerSpec) => {
  const plan = await planFor({ ...e, spec: s }, false);
  const result = await applyPlan({ ...e, spec: s }, plan);
  expect(result.failed).toBeNull();
  return plan;
};
const inChannel = (e: ReturnType<typeof env>, name: string) => {
  const c = e.f.channels.find((x) => x.name === name)!;
  return e.f.messages.filter((m) => m.channel_id === c.id);
};

test("an embed post is one embed: the file's title and link, its text with channels filled in, in its colour", async () => {
  const e = env();
  const plan = await apply(e, spec());
  const help = e.f.channels.find((c) => c.name === "help")!;
  const [m] = inChannel(e, "rules");
  expect(m!.content).toBe("");
  expect(m!.embeds).toEqual([{ title: "Rules", url: "https://example.com/rules", description: `1. Ask in <#${help.id}>.\n2. No spam.`, color: BLUE }]);
  expect(renderPlan(plan, spec())).toContain("+ rules, part 1 (an embed, ");
  expect((await planFor({ ...e, spec: spec() }, false)).ops).toEqual([]);
});

test("a text post becomes an embed in place, and back to text, each planning clean after", async () => {
  const e = env();
  const text = spec({ posts: [{ key: "rules", channel: "rules", file: "embed.md" }] });
  await apply(e, text);
  const id = inChannel(e, "rules")[0]!.id;

  const toEmbed = await apply(e, spec());
  expect(toEmbed.ops.map((o) => o.t)).toEqual(["post.edit"]);
  expect(inChannel(e, "rules")).toHaveLength(1);
  expect(inChannel(e, "rules")[0]).toMatchObject({ id, content: "", embeds: [{ title: "Rules" }] });
  expect((await planFor({ ...e, spec: spec() }, false)).ops).toEqual([]);

  const back = await apply(e, text);
  expect(back.ops).toMatchObject([{ t: "post.edit", clearEmbed: true }]);
  expect(inChannel(e, "rules")[0]).toMatchObject({ id, embeds: [] });
  expect(inChannel(e, "rules")[0]!.content).toStartWith("# [Rules]");
  expect((await planFor({ ...e, spec: text }, false)).ops).toEqual([]);
});

test("a new colour edits the embed in place", async () => {
  const e = env();
  await apply(e, spec());
  const red = spec({ posts: [{ key: "rules", channel: "rules", file: "embed.md", embed: { color: 0xdc2626 } }] });
  const plan = await apply(e, red);
  expect(plan.ops.map((o) => o.t)).toEqual(["post.edit"]);
  expect(inChannel(e, "rules")[0]!.embeds).toMatchObject([{ color: 0xdc2626 }]);
});

test("a link's preview isn't taken for the post's embed, whatever its type", async () => {
  for (const type of ["link", "rich"]) {
    const e = env();
    const text = spec({ posts: [{ key: "rules", channel: "rules", file: "embed.md" }] });
    await apply(e, text);
    inChannel(e, "rules")[0]!.embeds = [{ type, url: "https://example.com/rules", title: "Example" }];
    expect((await planFor({ ...e, spec: text }, false)).ops).toEqual([]);
  }
});

test("an embed in colour 0 plans clean when Discord leaves the colour out", async () => {
  const e = env();
  const black = spec({ posts: [{ key: "rules", channel: "rules", file: "embed.md", embed: { color: 0 } }] });
  await apply(e, black);
  delete (inChannel(e, "rules")[0]!.embeds![0] as { color?: number }).color;
  expect((await planFor({ ...e, spec: black }, false)).ops).toEqual([]);
});

test("an embed someone hid with Remove embeds is shown again, whether or not Discord still lists it", async () => {
  for (const listed of [false, true]) {
    const e = env();
    await apply(e, spec());
    const m = inChannel(e, "rules")[0]!;
    Object.assign(m, { flags: 4, ...(listed ? {} : { embeds: [] }) });
    const plan = await apply(e, spec());
    expect(plan.ops.map((o) => o.t)).toEqual(["post.edit"]);
    expect(inChannel(e, "rules")[0]).toMatchObject({ flags: 0, embeds: [{ title: "Rules" }] });
    expect((await planFor({ ...e, spec: spec() }, false)).ops).toEqual([]);
  }
});

test("a file is titled by its first heading, linked or not, and cut at a description's length", () => {
  expect(embedPost("# Help\nAsk away.", 1)).toEqual([{ title: "Help", description: "Ask away.", color: 1 }]);
  expect(embedPost("# [Help](https://x.example/help)\nAsk.", 1)).toEqual([{ title: "Help", url: "https://x.example/help", description: "Ask.", color: 1 }]);
  expect(embedPost("No heading here.", 1)).toEqual([{ description: "No heading here.", color: 1 }]);
  expect(embedPost("# Only a title", 1)).toEqual([{ title: "Only a title", color: 1 }]);
  const long = embedPost(`# Long\n${Array.from({ length: 3 }, (_, i) => `## Part ${i}\n${"x".repeat(3000)}`).join("\n\n")}`, 1);
  expect(long).toHaveLength(3);
  expect(long[0]!.title).toBe("Long");
  expect(long[1]!.title).toBeUndefined();
  expect(long.every((p) => (p.description ?? "").length <= 4096)).toBe(true);
});

test("an embed is for a file post, in a 24-bit colour", () => {
  expect(validateSpec(spec({ posts: [{ key: "x", channel: "rules", panel: "ticket", embed: { color: BLUE } }] }))).toContain('post "x": a panel is drawn by the bot, so it takes no embed');
  expect(validateSpec(spec({ posts: [{ key: "x", channel: "rules", file: "embed.md", embed: { color: 0x1000000 } }] }))).toContain(
    'post "x": embed colour must be a 24-bit colour such as 0x0080ff',
  );
});

test("an empty post file is refused, not planned as the post's deletion", () => {
  expect(validateSpec(spec({ posts: [{ key: "x", channel: "rules", file: "empty.md" }] }))).toContain('post "x": empty.md is empty');
});

test("an embed post's title past Discord's 256 characters is refused", () => {
  expect(validateSpec(spec({ posts: [{ key: "x", channel: "rules", file: "long-title.md", embed: { color: BLUE } }] }))).toContain(
    'post "x": its title is longer than 256 characters',
  );
});
