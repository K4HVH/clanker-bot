import { expect, test } from "bun:test";
import { type Summary, render, runComparison } from "../../src/lib/comparison-feed";
import { silentContext } from "../helpers/fakes";

const SITE = "https://medius.k4tech.net";

const latency = (medius: string, result: string | null = "medius") => ({
  id: "pass-latency-p50-1000",
  test: "Report latency, p50",
  case: "1 kHz mouse",
  stock: { text: "1.43-1.44 ms" },
  medius: { text: medius },
  result,
  defects: [],
});

const summary = (over: Partial<Summary> = {}): Summary => ({
  firmware: { stock: "V4.094", medius: "3.4.6" },
  url: `${SITE}/comparison`,
  areas: [
    {
      title: "Passthrough",
      url: `${SITE}/comparison/passthrough`,
      rows: [
        latency("1.07 ms"),
        {
          id: "pass-latency-p50-125",
          test: "Report latency, p50",
          case: "125 Hz mouse",
          stock: { text: "1.32-1.37 ms" },
          medius: { text: "4.57-4.65 ms" },
          result: "stock",
          defects: [{ box: "stock", url: `${SITE}/comparison/defect-interval` }],
        },
        {
          id: "pass-seq-1000",
          test: "Mouse reports reaching the PC",
          case: "1 kHz mouse",
          stock: { text: "All, once, in order" },
          medius: { text: "All, once, in order" },
          result: "equal",
          defects: [],
        },
      ],
    },
    {
      title: "Features",
      url: `${SITE}/comparison/features`,
      rows: [
        {
          id: "feat-move-absolute",
          test: "Absolute move on a virtual screen",
          case: "Moves",
          stock: { text: "km.moveto", code: true },
          medius: { text: "No" },
          result: "stock",
          defects: [],
        },
      ],
    },
  ],
  defects: [
    {
      box: "stock",
      text: "A mouse's clone declares a 1 ms poll interval.",
      url: `${SITE}/comparison/defect-interval`,
      where: { title: "Poll interval", url: `${SITE}/comparison/devices/devices-interval` },
    },
  ],
  ...over,
});

const BLUE = 0x0080ff;
const RED = 0xdc2626;
const row = (test: string, kase: string, stock: string, medius: string) => [
  { name: test, value: kase, inline: true },
  { name: "Stock", value: stock, inline: true },
  { name: "Medius", value: medius, inline: true },
];

const FIRST = [
  {
    title: "Stock vs Medius",
    url: `${SITE}/comparison`,
    color: BLUE,
    description:
      "Stock MAKCU firmware V4.094 and Medius 3.4.6, tested the same way on two MAKCU boxes. The main results from each area are below, and each area's page has the rest.",
  },
  {
    title: "Passthrough",
    url: `${SITE}/comparison/passthrough`,
    color: BLUE,
    fields: [
      ...row("Report latency, p50", "1 kHz mouse", "1.43-1.44 ms", "**1.07 ms** ✓"),
      ...row("Report latency, p50", "125 Hz mouse", `**1.32-1.37 ms** ✓\n[Stock defect](${SITE}/comparison/defect-interval)`, "4.57-4.65 ms"),
      ...row("Mouse reports reaching the PC", "1 kHz mouse", "All, once, in order", "All, once, in order"),
    ],
  },
  { title: "Features", url: `${SITE}/comparison/features`, color: BLUE, fields: row("Absolute move on a virtual screen", "Moves", "**`km.moveto`** ✓", "No") },
  {
    title: "Defects",
    color: RED,
    description: `**Stock**\n- A mouse's clone declares a 1 ms poll interval. ([Poll interval](${SITE}/comparison/devices/devices-interval))\n\n**Medius**\nNone found`,
  },
];

interface Embed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
}

interface Post {
  id: string;
  content: string;
  embeds: Embed[];
  flags?: number;
}

// The characters of embed text Discord counts against a message.
const size = (embeds: Embed[]) =>
  embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);

// A channel holding the bot's posts, with what was sent, edited and deleted.
function board() {
  let next = 1;
  const posts = new Map<string, Post>();
  const log: string[] = [];
  let failSend = -1;
  let failDelete = -1;
  return {
    posts,
    log,
    failNthSend: (n: number) => (failSend = n),
    failNthDelete: (n: number) => (failDelete = n),
    embeds: () => [...posts.values()].map((p) => p.embeds),
    contents: () => [...posts.values()].map((p) => JSON.stringify(p.embeds)),
    send: async (o: { embeds: Embed[]; flags?: number }) => {
      if (failSend-- === 0) throw new Error("refused");
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
        if (failDelete-- === 0) throw new Error("Discord is down");
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

test("the summary is posted silently as embeds: Overview's line, each area's results in columns with the box ahead ticked, and the defects", async () => {
  const s = setup(summary());
  await s.run();
  expect([...s.c1.posts.values()]).toEqual([{ id: "m1", content: "", embeds: FIRST, flags: 4096 }]);
});

test("a summary that hasn't changed touches nothing", async () => {
  const s = setup(summary());
  await s.run();
  await s.run();
  expect(s.c1.log).toEqual(["send m1"]);
});

test("a changed result edits its message in place", async () => {
  const s = setup(summary());
  await s.run();
  s.serve(summary({ areas: [{ ...summary().areas[0]!, rows: [latency("1.50 ms", "stock")] }, summary().areas[1]!] }));
  await s.run();
  expect(s.c1.log).toEqual(["send m1", "edit m1"]);
  expect(s.c1.embeds()[0]![1]!.fields).toEqual(row("Report latency, p50", "1 kHz mouse", "**1.43-1.44 ms** ✓", "1.50 ms"));
});

const many = (n: number) =>
  summary({
    areas: Array.from({ length: n }, (_, i) => ({
      title: `Area ${i}`,
      url: `${SITE}/comparison/a${i}`,
      rows: Array.from({ length: 6 }, (_, j) => ({ ...latency("1.07 ms"), id: `r${i}-${j}`, case: `mouse number ${j} of area ${i}` })),
    })),
  });

test("a summary past one message goes out in parts within Discord's limits, and edits, adds or removes parts as it changes", async () => {
  const s = setup(many(12));
  await s.run();
  const parts = s.c1.embeds();
  expect(parts.length).toBe(2);
  expect(parts.every((p) => p.length <= 10 && size(p) <= 6000)).toBe(true);
  for (let i = 0; i < 12; i++) expect(parts.flat().filter((e) => e.title === `Area ${i}`)).toHaveLength(1);
  expect([...s.c1.posts.values()].every((p) => p.flags === 4096)).toBe(true);

  s.serve(many(20));
  await s.run();
  expect(s.c1.embeds().flat().some((e) => e.title === "Area 19")).toBe(true);
  expect(s.c1.embeds()).toHaveLength(3);
  expect(s.c1.log.filter((l) => l.startsWith("delete"))).toEqual([]);

  s.serve(many(2));
  await s.run();
  expect(s.c1.embeds()).toHaveLength(1);
  expect(s.c1.embeds()[0]!.at(-1)!.description).toEndWith("**Medius**\nNone found");
});

test("an area with more results than an embed holds goes on in the next, without its title again", () => {
  const big = summary({
    areas: [{ title: "Big", url: `${SITE}/comparison/big`, rows: Array.from({ length: 10 }, (_, j) => ({ ...latency("1.07 ms"), id: `r${j}` })) }],
  });
  const [area, more] = render(big)[0]!.embeds.slice(1, 3);
  expect(area).toMatchObject({ title: "Big", url: `${SITE}/comparison/big` });
  expect(area!.fields).toHaveLength(24);
  expect(more!.title).toBeUndefined();
  expect(more!.fields).toHaveLength(6);
});

test("a part someone deleted has the summary posted again whole, so the parts stay in order", async () => {
  const s = setup(summary());
  await s.run();
  s.c1.posts.delete("m1");
  await s.run();
  expect(s.c1.embeds()).toEqual([FIRST]);
  expect(s.c1.log).toEqual(["send m1", "send m2"]);
});

test("a new channel gets the summary, and the old channel's posts are taken down", async () => {
  const s = setup(summary());
  await s.run();
  s.ctx.config.set("g", "comparison_channel_id", "c2");
  await s.run();
  expect(s.boards.c1.contents()).toEqual([]);
  expect(s.boards.c2.embeds()).toEqual([FIRST]);
});

test("a middle part someone deleted has the summary posted again whole, in order", async () => {
  const whole = setup(many(12));
  await whole.run();
  const s = setup(many(12));
  await s.run();
  const ids = [...s.c1.posts.keys()];
  s.c1.posts.delete(ids[1]!);
  await s.run();
  expect(s.c1.contents()).toEqual(whole.c1.contents());
  for (const id of ids) expect(s.c1.posts.has(id)).toBe(false);
});

test("a take-down stopped part way is finished on the next read, and the summary posted once", async () => {
  const s = setup(many(12));
  await s.run();
  const count = s.c1.posts.size;
  s.c1.posts.delete([...s.c1.posts.keys()][0]!);
  s.c1.failNthDelete(1); // the second part's delete, after the first was taken down
  await s.run().catch(() => {});
  await s.run();
  await s.run();
  expect(s.c1.contents()).toHaveLength(count);
  const again = setup(many(12));
  await again.run();
  expect(s.c1.contents()).toEqual(again.c1.contents());
  expect(s.c1.log.filter((l) => l.startsWith("edit"))).toEqual([]);
});

test("a post that fails part way is carried on from the next read, in order", async () => {
  const whole = setup(many(12));
  await whole.run();
  const s = setup(many(12));
  s.c1.failNthSend(1);
  await s.run().catch(() => {});
  expect(s.c1.contents()).toHaveLength(1);
  await s.run();
  expect(s.c1.contents()).toEqual(whole.c1.contents());
});

test("site text is shown as typed, and a value the site marks as a command is code", async () => {
  const odd = summary({
    areas: [
      {
        title: "Odd *area*",
        url: `${SITE}/comparison/odd`,
        rows: [{ ...latency("1 ms"), test: "**Bold** [x](https://bad.example)", case: "a_b", stock: { text: "km.move_to", code: true } }],
      },
    ],
  });
  const s = setup(odd);
  await s.run();
  const area = s.c1.embeds()[0]![1]!;
  expect(area.title).toBe("Odd \\*area\\*");
  expect(area.fields).toEqual(row("\\*\\*Bold\\*\\* \\[x\\](https://bad.example)", "a\\_b", "`km.move_to`", "**1 ms** ✓"));
});

test("a list that can't be read, or no channel set, posts nothing and keeps what's posted", async () => {
  const s = setup(summary());
  await s.run();
  for (const bad of [null, { areas: "x" }, { ...summary(), firmware: null }]) {
    s.serve(bad);
    await s.run();
  }
  expect(s.c1.log).toEqual(["send m1"]);
  s.serve(summary({ firmware: { stock: "V4.094", medius: "3.4.7" } }));
  s.ctx.config.unset("g", "comparison_channel_id");
  await s.run();
  expect(s.c1.log).toEqual(["send m1"]);
});

test("a summary with any part the bot can't read is not posted, so it never shows a part of the results", async () => {
  const areas = summary().areas;
  const { defects: _, ...noDefects } = summary();
  const s = setup(summary());
  await s.run();
  for (const bad of [
    { ...summary(), areas: [{ ...areas[0]!, rows: [{ id: "x", test: "Broken" }, ...areas[0]!.rows] }, areas[1]] },
    { ...summary(), defects: [{ box: "stock", text: 7 }, ...summary().defects] },
    noDefects,
    { ...summary(), areas: [] },
    { ...summary(), areas: [{ ...areas[0]!, rows: [] }] },
  ]) {
    s.serve(bad);
    await s.run();
  }
  expect(s.c1.log).toEqual(["send m1"]);
  expect(s.c1.embeds()).toEqual([FIRST]);
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

test("a summary posted as text before is turned into embeds in place", async () => {
  const s = setup(summary());
  await s.run();
  s.c1.posts.get("m1")!.content = "the old text summary";
  s.ctx.db.query("UPDATE comparison_posts SET content = 'the old text summary'").run();
  await s.run();
  expect(s.c1.log).toEqual(["send m1", "edit m1"]);
  expect([...s.c1.posts.values()]).toEqual([{ id: "m1", content: "", embeds: FIRST, flags: 4096 }]);
});

test("an area of long results is split by size as well as count, each embed and message within Discord's limits", () => {
  const long = summary({
    areas: [{ title: "Long", url: `${SITE}/comparison/long`, rows: Array.from({ length: 8 }, (_, j) => ({ ...latency("1 ms"), id: `r${j}`, case: "c".repeat(1000) })) }],
  });
  const messages = render(long);
  const areas = messages.flatMap((m) => m.embeds).filter((e) => e.fields);
  expect(areas.length).toBeGreaterThan(1);
  expect(areas.flatMap((e) => e.fields!)).toHaveLength(24);
  for (const { embeds } of messages) expect(size(embeds)).toBeLessThanOrEqual(6000);
});

test("a message that opens part way through an area names it again; one that carries on in the same message doesn't", () => {
  const long = summary({
    areas: [{ title: "Long", url: `${SITE}/comparison/long`, rows: Array.from({ length: 8 }, (_, j) => ({ ...latency("1 ms"), id: `r${j}`, case: "c".repeat(1000) })) }],
  });
  const messages = render(long);
  for (const { embeds } of messages) {
    expect(embeds[0]!.title).toBeDefined();
    embeds.forEach((e, i) => {
      if (i > 0 && e.fields && embeds[i - 1]!.fields) expect(e.title).toBeUndefined();
    });
  }
});

test("render keeps every embed within Discord's limits, cutting text too long for its place", () => {
  const long = summary({
    areas: [{ ...summary().areas[0]!, title: "t".repeat(300), rows: [{ ...latency("1 ms"), test: "n".repeat(300), case: "c".repeat(1100) }] }],
    defects: Array.from({ length: 4 }, () => ({ ...summary().defects[0]!, text: "d".repeat(2500) })),
  });
  const messages = render(long);
  for (const { embeds } of messages) {
    expect(embeds.length).toBeLessThanOrEqual(10);
    expect(size(embeds)).toBeLessThanOrEqual(6000);
    for (const e of embeds) {
      expect((e.title ?? "").length).toBeLessThanOrEqual(256);
      expect((e.description ?? "").length).toBeLessThanOrEqual(4096);
      for (const f of e.fields ?? []) expect(f.name.length <= 256 && f.value.length <= 1024).toBe(true);
    }
  }
  expect(JSON.stringify(messages)).toContain("…");
});
