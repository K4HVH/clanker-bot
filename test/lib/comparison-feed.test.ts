import { expect, test } from "bun:test";
import { type Summary, render, runComparison } from "../../src/lib/comparison-feed";
import { silentContext } from "../helpers/fakes";

const SITE = "https://medius.k4tech.net";

const summary = (over: Partial<Summary> = {}): Summary => ({
  firmware: { stock: "V4.094", medius: "3.4.6" },
  url: `${SITE}/comparison`,
  total: { medius: 48, stock: 18, same: 120 },
  areas: [
    { title: "Devices", url: `${SITE}/comparison/devices`, medius: 27, stock: 5, same: 80 },
    { title: "Passthrough", url: `${SITE}/comparison/passthrough`, medius: 21, stock: 13, same: 40 },
  ],
  defects: { stock: 11, medius: 0, url: `${SITE}/comparison/defects` },
  ...over,
});

const FIRST = {
  title: "Stock V4.094 vs Medius 3.4.6",
  description: [`Stock has [11 defects](${SITE}/comparison/defects). Medius has none.`, "", `**[Read the full comparison](${SITE}/comparison)**`].join("\n"),
  fields: [
    { name: "Medius ahead", value: "48", inline: true },
    { name: "Stock ahead", value: "18", inline: true },
    { name: "Equal", value: "120", inline: true },
    { name: "Devices", value: `Medius 27, stock 5, equal 80\n[All results](${SITE}/comparison/devices)`, inline: true },
    { name: "Passthrough", value: `Medius 21, stock 13, equal 40\n[All results](${SITE}/comparison/passthrough)`, inline: true },
  ],
};

interface Embed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}

interface Post {
  id: string;
  content: string;
  embeds: Embed[];
  flags?: number;
}

// A channel holding the bot's posts, with what was sent, edited and deleted.
function board() {
  let next = 1;
  const posts = new Map<string, Post>();
  const log: string[] = [];
  return {
    posts,
    log,
    embeds: () => [...posts.values()].map((p) => p.embeds),
    send: async (o: { embeds: Embed[]; flags?: number }) => {
      const id = `m${next++}`;
      posts.set(id, { id, content: "", embeds: o.embeds, ...(o.flags ? { flags: o.flags } : {}) });
      log.push(`send ${id}`);
      return { id };
    },
    messages: {
      fetch: async (id: string) => {
        if (!posts.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return posts.get(id);
      },
      edit: async (id: string, o: { content: string; embeds: Embed[]; flags?: number }) => {
        if (!posts.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        const p = posts.get(id)!;
        Object.assign(p, { content: o.content, embeds: o.embeds });
        // An edit can set or clear only the suppress-embeds flag.
        if (o.flags !== undefined) p.flags = ((p.flags ?? 0) & ~4) | (o.flags & 4);
        log.push(`edit ${id}`);
      },
      delete: async (id: string) => {
        if (!posts.delete(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        log.push(`delete ${id}`);
      },
    },
  };
}

function setup(first: unknown) {
  const ctx = silentContext();
  ctx.config.set("g", "comparison_channel_id", "c1");
  let body: unknown = first;
  const boards = { c1: board(), c2: board() };
  const fetchList = async () => (body === null ? new Response("down", { status: 502 }) : new Response(JSON.stringify(body), { status: 200 }));
  return {
    ctx,
    boards,
    c1: boards.c1,
    serve: (b: unknown) => (body = b),
    run: () => runComparison(ctx, "g", async (id) => boards[id as keyof typeof boards] ?? null, fetchList as unknown as typeof fetch),
  };
}

test("the summary is one embed, posted silently: the totals, each box's defects and each area, every one linking the site", async () => {
  const s = setup(summary());
  await s.run();
  expect([...s.c1.posts.values()]).toEqual([{ id: "m1", content: "", embeds: [FIRST], flags: 4096 }]);
});

test("a box with defects links them, one with none says so", () => {
  const both = render(summary({ defects: { stock: 1, medius: 2, url: `${SITE}/comparison/defects` } }));
  expect(both.description).toContain(`Stock has [1 defect](${SITE}/comparison/defects). Medius has [2 defects](${SITE}/comparison/defects).`);
});

test("a summary that hasn't changed touches nothing", async () => {
  const s = setup(summary());
  await s.run();
  await s.run();
  expect(s.c1.log).toEqual(["send m1"]);
});

test("a changed count edits the post in place", async () => {
  const s = setup(summary());
  await s.run();
  s.serve(summary({ total: { medius: 49, stock: 18, same: 119 } }));
  await s.run();
  expect(s.c1.log).toEqual(["send m1", "edit m1"]);
  expect(s.c1.embeds()[0]![0]!.fields![0]).toEqual({ name: "Medius ahead", value: "49", inline: true });
});

test("a post someone deleted is posted again", async () => {
  const s = setup(summary());
  await s.run();
  s.c1.posts.delete("m1");
  await s.run();
  expect(s.c1.embeds()).toEqual([[FIRST]]);
  expect(s.c1.log).toEqual(["send m1", "send m2"]);
});

test("a new channel gets the summary, and the old channel's post comes down", async () => {
  const s = setup(summary());
  await s.run();
  s.ctx.config.set("g", "comparison_channel_id", "c2");
  await s.run();
  expect(s.boards.c1.embeds()).toEqual([]);
  expect(s.boards.c2.embeds()).toEqual([[FIRST]]);
});

test("embeds someone hid are shown again", async () => {
  const s = setup(summary());
  await s.run();
  s.c1.posts.get("m1")!.flags = 4096 | 4;
  await s.run();
  expect(s.c1.log).toEqual(["send m1", "edit m1"]);
  expect(s.c1.posts.get("m1")!.flags).toBe(4096);
  await s.run();
  expect(s.c1.log).toEqual(["send m1", "edit m1"]);
});

test("a summary posted as text before becomes the embed in place", async () => {
  const s = setup(summary());
  await s.run();
  s.c1.posts.get("m1")!.content = "the old text summary";
  s.ctx.db.query("UPDATE comparison_posts SET content = 'the old text summary'").run();
  await s.run();
  expect(s.c1.log).toEqual(["send m1", "edit m1"]);
  expect([...s.c1.posts.values()]).toEqual([{ id: "m1", content: "", embeds: [FIRST], flags: 4096 }]);
});

test("site text is shown as typed", () => {
  const odd = render(summary({ areas: [{ ...summary().areas[0]!, title: "Odd *area*" }], firmware: { stock: "V4_094", medius: "3.4.6" } }));
  expect(odd.fields![3]!.name).toBe("Odd \\*area\\*");
  expect(odd.title).toBe("Stock V4\\_094 vs Medius 3.4.6");
});

test("a summary that can't be read, or no channel set, posts nothing and keeps what's posted", async () => {
  const s = setup(summary());
  await s.run();
  const { defects: _, ...noDefects } = summary();
  for (const bad of [
    null,
    { areas: "x" },
    { ...summary(), firmware: null },
    noDefects,
    { ...summary(), areas: [] },
    { ...summary(), areas: [{ title: "Devices", url: `${SITE}/comparison/devices`, medius: 1 }] },
    { ...summary(), total: { medius: -1, stock: 0, same: 0 } },
  ]) {
    s.serve(bad);
    await s.run();
  }
  expect(s.c1.log).toEqual(["send m1"]);
  s.serve(summary({ firmware: { stock: "V4.094", medius: "3.4.7" } }));
  s.ctx.config.unset("g", "comparison_channel_id");
  await s.run();
  expect(s.c1.log).toEqual(["send m1"]);
});
