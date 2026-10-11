import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { type ApplyEnv, applyPlan, planFor } from "../../src/server/apply";
import { chunk } from "../../src/server/history";
import { renderPlan } from "../../src/server/render";
import { defineServer, type ServerSpec, validateSpec } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: import.meta.dir,
    guild: {},
    everyone: { permissions: [] },
    roles: [],
    channels: [{ key: "backup", type: "text", name: "backup" }],
    retired: [{ key: "old", name: "old", into: "backup" }],
    automod: [],
    posts: [],
    bot: {},
    ...over,
  });

const files = new Map([["https://cdn.example/fix.sh", new TextEncoder().encode("echo fix")]]);

function setup() {
  const f = new FakeDiscord();
  const db = createDatabase(":memory:");
  const e: ApplyEnv & { f: FakeDiscord } = {
    f,
    api: f,
    db,
    config: new ConfigService(db),
    guildId: f.guildId,
    spec: spec(),
    reason: "test",
    download: async (url) => {
      const data = files.get(url);
      if (!data) throw new Error(`no file at ${url}`);
      return data;
    },
  };
  const old = f.addChannel({ name: "old" });
  const say = (content: string, extra: Partial<Parameters<FakeDiscord["addMessage"]>[3]> = {}) =>
    f.addMessage(old.id, content, "4242", { author: { id: "4242", username: "k4hvh" }, timestamp: "2026-06-29T10:00:00.000Z", ...extra });
  say("# FAQs");
  say("Linux", { attachments: [{ filename: "fix.sh", url: "https://cdn.example/fix.sh", size: 8 }] });
  say("https://medius.k4tech.net", { flags: 4 });
  say("", { type: 7 }); // a join notice: not copied
  return { e, f, old, say };
}

const backupOf = (f: FakeDiscord) => {
  const backup = f.channels.find((c) => c.name === "backup")!;
  return f.messages.filter((m) => m.channel_id === backup.id);
};

test("a retired channel's messages are copied into the channel the file names, then it is deleted", async () => {
  const { e, f, old } = setup();
  const plan = await planFor(e, true);
  expect(plan.ops.find((o) => o.t === "channel.backup")).toMatchObject({ key: "old", into: "backup", from: null, messages: 3, files: 1 });
  expect(plan.ops.some((o) => o.t === "channel.delete" && o.key === "old")).toBe(true);
  expect(renderPlan(plan, e.spec)).toContain("#old: copy 3 messages and 1 file into #backup");
  expect((await applyPlan(e, plan)).failed).toBeNull();

  const copied = backupOf(f);
  expect(copied.map((m) => m.content)).toEqual([
    "# old",
    "-# k4hvh, <t:1782727200:f>\n# FAQs",
    "-# k4hvh, <t:1782727200:f>\nLinux",
    "-# k4hvh, <t:1782727200:f>\nhttps://medius.k4tech.net",
  ]);
  expect(copied[2]!.attachments).toEqual([{ filename: "fix.sh", size: 8, url: expect.any(String) }]);
  expect(copied[3]!.flags).toBe(4);
  expect(f.writes.filter((w) => w.method === "POST" && w.route.endsWith("/messages")).every((w) => JSON.stringify((w.body as { allowed_mentions?: unknown }).allowed_mentions) === '{"parse":[]}')).toBe(true);
  expect(f.channels.some((c) => c.id === old.id)).toBe(false);
  expect((await planFor(e, true)).ops).toEqual([]);
});

test("held deletion: the copy runs once, and the next plan copies only what's new", async () => {
  const { e, f, say } = setup();
  const first = await planFor(e, false);
  expect(first.held.map((o) => o.t)).toEqual(["channel.delete"]);
  await applyPlan(e, first);
  expect((await planFor(e, false)).ops).toEqual([]);

  say("one more");
  const next = await planFor(e, false);
  expect(next.ops.find((o) => o.t === "channel.backup")).toMatchObject({ messages: 1, files: 0 });
  await applyPlan(e, next);
  const copied = backupOf(f).map((m) => m.content);
  expect(copied.filter((c) => c === "# old")).toHaveLength(1);
  expect(copied.at(-1)).toBe("-# k4hvh, <t:1782727200:f>\none more");
});

test("a copy stopped part way carries on after the last message it copied", async () => {
  const { e, f } = setup();
  let posts = 0;
  f.refuse((w) => w.method === "POST" && ++posts === 3);
  expect((await applyPlan(e, await planFor(e, true))).failed?.op.t).toBe("channel.backup");
  f.allowAll();
  expect((await applyPlan(e, await planFor(e, true))).failed).toBeNull();
  expect(backupOf(f).map((m) => m.content.split("\n").at(-1))).toEqual(["# old", "# FAQs", "Linux", "https://medius.k4tech.net"]);
});

test("a retired channel with threads is copied but kept, and the plan says why", async () => {
  const { e, f, old } = setup();
  f.addChannel({ name: "a thread", type: 11, parent_id: old.id });
  const plan = await planFor(e, true);
  expect(plan.ops.some((o) => o.t === "channel.delete")).toBe(false);
  expect(plan.manual).toEqual([
    "#old has 1 thread, whose messages aren't copied, so the plan keeps the channel. Copy or delete the thread by hand, then plan again",
  ]);
});

test("once retired, a new channel with the old name isn't touched", async () => {
  const { e, f } = setup();
  await applyPlan(e, await planFor(e, true));
  f.addChannel({ name: "old" });
  const plan = await planFor(e, true);
  expect(plan.ops).toEqual([]);
  expect(plan.unmanaged).toContain("#old");
});

test("a retired channel names a text channel in the file to copy into", () => {
  expect(validateSpec(spec())).toEqual([]);
  expect(validateSpec(spec({ retired: [{ key: "old", name: "old", into: "nowhere" }] }))).toEqual(['retired "old": unknown channel "nowhere"']);
  expect(validateSpec(spec({ retired: [{ key: "backup", name: "old", into: "backup" }] }))).toEqual(['channel key "backup" used twice']);
});

test("a message posted after the plan stops the delete, and the next plan copies it", async () => {
  const { e, f, old, say } = setup();
  const plan = await planFor(e, true);
  say("posted late");
  const result = await applyPlan(e, plan);
  expect(result.failed?.op.t).toBe("channel.delete");
  expect(result.failed?.error).toBe("#old has 1 message the plan didn't copy. Plan again to copy it before the channel goes");
  expect(f.channels.some((c) => c.id === old.id)).toBe(true);
  expect((await applyPlan(e, await planFor(e, true))).failed).toBeNull();
  expect(backupOf(f).at(-1)!.content).toEndWith("\nposted late");
  expect(f.channels.some((c) => c.id === old.id)).toBe(false);
});

test("an empty retired channel, once deleted, leaves a new one of that name alone", async () => {
  const { e, f, old } = setup();
  f.messages = f.messages.filter((m) => m.channel_id !== old.id);
  const plan = await planFor(e, true);
  expect(plan.ops.some((o) => o.t === "channel.backup")).toBe(false);
  expect(plan.ops.some((o) => o.t === "channel.delete")).toBe(true);
  await applyPlan(e, plan);
  f.addChannel({ name: "old" });
  expect((await planFor(e, true)).ops).toEqual([]);
});

test("a long message that fails part way is taken back, so the next run posts it once", async () => {
  const { e, f, say } = setup();
  const long = `${"x".repeat(1990)}\n${"y".repeat(100)}`;
  say(long);
  let posts = 0;
  // The header, three messages, then the long one's first part; its second part is refused.
  f.refuse((w) => w.method === "POST" && w.route.endsWith("/messages") && ++posts === 6);
  expect((await applyPlan(e, await planFor(e, true))).failed?.op.t).toBe("channel.backup");
  f.allowAll();
  expect((await applyPlan(e, await planFor(e, true))).failed).toBeNull();
  const copied = backupOf(f).map((m) => m.content);
  expect(copied.filter((c) => c.startsWith("-# k4hvh") && c.includes("xxxx"))).toHaveLength(1);
  expect(copied.filter((c) => c.includes("yyyy"))).toHaveLength(1);
  expect(copied.slice(-2).join("")).toBe(`-# k4hvh, <t:1782727200:f>\n${long}`);
});

test("a message that can't be copied is named, with what to do", async () => {
  const { e, f } = setup();
  const linux = f.messages.find((m) => m.content === "Linux")!;
  f.refuse((w) => (w.files?.length ?? 0) > 0, 413, 40005, "Request entity too large");
  const result = await applyPlan(e, await planFor(e, true));
  expect(result.failed?.error).toBe(`Message ${linux.id} in #old: Request entity too large`);
  expect(result.failed?.hint).toBe(
    "A file in that message is bigger than the bot may upload to this server. Keep the file somewhere else, delete the message, then plan again.",
  );
});

test("prune leaves alone channels that carry a retired name", async () => {
  const { e, f } = setup();
  f.addChannel({ name: "old" });
  const plan = await planFor(e, true, true);
  expect(plan.ops.filter((o) => o.t === "prune")).toEqual([]);
  expect(plan.manual).toContain('2 channels named "old": rename one in Discord so "old" can bind to the other, then plan again');
});

test("forwarded messages and polls are copied as far as Discord allows", async () => {
  const { e, f, say } = setup();
  say("", { message_snapshots: [{ message: { content: "forwarded text", attachments: [] } }] } as never);
  say("", { poll: { question: { text: "Which mouse?" } } } as never);
  say("no timestamp", { timestamp: undefined });
  await applyPlan(e, await planFor(e, true));
  const copied = backupOf(f).map((m) => m.content);
  expect(copied).toContain("-# k4hvh, <t:1782727200:f>\n[forwarded]\nforwarded text");
  expect(copied).toContain("-# k4hvh, <t:1782727200:f>\n[poll: Which mouse?]");
  expect(copied.at(-1)).toMatch(/^-# k4hvh, <t:\d+:f>\nno timestamp$/);
});

test("long text is cut into messages that give it back exactly", () => {
  const text = `${"a ".repeat(1500)}\n${"b".repeat(2500)}😀${"c".repeat(10)}`;
  const parts = chunk(text);
  expect(parts.join("")).toBe(text);
  expect(parts.every((p) => p.length <= 2000)).toBe(true);
  expect(parts[0]!.endsWith("\n") || parts[0]!.endsWith(" ")).toBe(true);
  expect(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
});

test("replies to commands are copied like any other message", async () => {
  const { e, f, say } = setup();
  say("a command's answer", { type: 20 });
  await applyPlan(e, await planFor(e, true));
  expect(backupOf(f).at(-1)!.content).toEndWith("\na command's answer");
});
