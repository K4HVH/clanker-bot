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

const FIRST = [
  `# [Stock vs Medius](<${SITE}/comparison>)`,
  "Stock MAKCU firmware V4.094 and Medius 3.4.6, tested the same way on two MAKCU boxes. The main results from each area are below, and each area's page has the rest.",
  "",
  `### [Passthrough](<${SITE}/comparison/passthrough>)`,
  "- Report latency, p50 (1 kHz mouse) | Stock: 1.43-1.44 ms | **Medius: 1.07 ms**",
  `- Report latency, p50 (125 Hz mouse) | **Stock: 1.32-1.37 ms** | Medius: 4.57-4.65 ms | [Stock defect](<${SITE}/comparison/defect-interval>)`,
  "- Mouse reports reaching the PC (1 kHz mouse) | Stock: All, once, in order | Medius: All, once, in order",
  "",
  `### [Features](<${SITE}/comparison/features>)`,
  "- Absolute move on a virtual screen (Moves) | **Stock: `km.moveto`** | Medius: No",
  "",
  "### Defects",
  `- Stock: A mouse's clone declares a 1 ms poll interval. ([Poll interval](<${SITE}/comparison/devices/devices-interval>))`,
  "- Medius: None found",
].join("\n");

interface Post {
  id: string;
  content: string;
  flags?: number;
}

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
    contents: () => [...posts.values()].map((p) => p.content),
    send: async (o: { content: string; flags?: number }) => {
      if (failSend-- === 0) throw new Error("refused");
      const id = `m${next++}`;
      posts.set(id, { id, content: o.content, ...(o.flags ? { flags: o.flags } : {}) });
      log.push(`send ${id}`);
      return { id };
    },
    messages: {
      fetch: async (id: string) => {
        if (!posts.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return posts.get(id);
      },
      edit: async (id: string, o: { content: string }) => {
        if (!posts.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        posts.get(id)!.content = o.content;
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

test("the summary is posted silently and without link previews, Overview's areas and defects with the box ahead in bold", async () => {
  const s = setup(summary());
  await s.run();
  expect([...s.c1.posts.values()]).toEqual([{ id: "m1", content: FIRST, flags: 4100 }]);
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
  expect(s.c1.posts.get("m1")!.content).toContain("- Report latency, p50 (1 kHz mouse) | **Stock: 1.43-1.44 ms** | Medius: 1.50 ms\n");
});

const many = (n: number) =>
  summary({
    areas: Array.from({ length: n }, (_, i) => ({
      title: `Area ${i}`,
      url: `${SITE}/comparison/a${i}`,
      rows: Array.from({ length: 6 }, (_, j) => ({ ...latency("1.07 ms"), id: `r${i}-${j}`, case: `mouse number ${j} of area ${i}` })),
    })),
  });

test("a summary longer than a message goes out in parts, each area whole, and edits, adds or removes parts as it changes", async () => {
  const s = setup(many(12));
  await s.run();
  const parts = s.c1.contents();
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.every((p) => p.length <= 2000)).toBe(true);
  for (let i = 0; i < 12; i++) expect(parts.filter((p) => p.includes(`### [Area ${i}]`)).length).toBe(1);
  expect([...s.c1.posts.values()].every((p) => p.flags === 4100)).toBe(true);

  s.serve(many(16));
  await s.run();
  expect(s.c1.contents().join("\n")).toContain("### [Area 15]");
  expect(s.c1.log.filter((l) => l.startsWith("delete"))).toEqual([]);

  s.serve(many(2));
  await s.run();
  expect(s.c1.contents()).toHaveLength(1);
  expect(s.c1.contents()[0]).toEndWith("- Medius: None found");
});

test("a part someone deleted has the summary posted again whole, so the parts stay in order", async () => {
  const s = setup(summary());
  await s.run();
  s.c1.posts.delete("m1");
  await s.run();
  expect(s.c1.contents()).toEqual([FIRST]);
  expect(s.c1.log).toEqual(["send m1", "send m2"]);
});

test("a new channel gets the summary, and the old channel's posts are taken down", async () => {
  const s = setup(summary());
  await s.run();
  s.ctx.config.set("g", "comparison_channel_id", "c2");
  await s.run();
  expect(s.boards.c1.contents()).toEqual([]);
  expect(s.boards.c2.contents()).toEqual([FIRST]);
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
  const text = s.c1.contents()[0]!;
  expect(text).toContain(`### [Odd \\*area\\*](<${SITE}/comparison/odd>)`);
  expect(text).toContain("- \\*\\*Bold\\*\\* \\[x\\](https://bad.example) (a\\_b) | Stock: `km.move_to` | **Medius: 1 ms**");
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
  expect(s.c1.contents()).toEqual([FIRST]);
});

test("render puts no line past a message", () => {
  const long = summary({ defects: [{ ...summary().defects[0]!, text: "n".repeat(2500) }] });
  const parts = render(long);
  expect(parts.every((p) => p.length <= 2000)).toBe(true);
  expect(parts.join("\n")).toContain("…");
});
