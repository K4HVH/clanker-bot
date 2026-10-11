import { expect, test } from "bun:test";
import { type FeedDevice, feedText, runFeed } from "../../src/lib/device-feed";
import { silentContext } from "../helpers/fakes";

const atk: FeedDevice = { name: "ATK X1 NK 8K", kind: "mouse", verdict: "works", reported: "v3.4.5" };
const shark: FeedDevice = { name: "Attack Shark R5 Ultra", kind: "mouse", verdict: "partial", note: "Over wireless, the vendor's app can't see it", reported: "v3.0.1" };
const probe: FeedDevice = { name: "Probe Mouse", kind: "mouse", verdict: "works", vidpid: "1234:abcd", boxes: 2 };

function setup(lists: FeedDevice[][]) {
  const ctx = silentContext();
  ctx.config.set("g", "device_feed_channel_id", "c1");
  const sent: string[] = [];
  let call = 0;
  const fetchList = async () => {
    const devices = lists[Math.min(call++, lists.length - 1)]!;
    return new Response(JSON.stringify({ devices, stats: true }), { status: 200 });
  };
  const channel = async (id: string) => (id === "c1" ? { send: async (o: { content: string }) => void sent.push(o.content) } : null);
  return { ctx, sent, run: () => runFeed(ctx, "g", channel, fetchList as unknown as typeof fetch) };
}

test("the first run records the list without posting it", async () => {
  const s = setup([[atk, shark]]);
  await s.run();
  expect(s.sent).toEqual([]);
});

test("a device new to the list is posted, from a report or from the stats", async () => {
  const s = setup([[atk], [atk, shark, probe]]);
  await s.run();
  await s.run();
  expect(s.sent).toEqual([
    [
      "Added to Devices:",
      "- **Attack Shark R5 Ultra** (mouse): Partial, reported on v3.0.1. Over wireless, the vendor's app can't see it",
      "- **Probe Mouse** (mouse): Supported, seen on 2 boxes",
      "<https://medius.k4tech.net/guide/compatibility>",
    ].join("\n"),
  ]);
  await s.run();
  expect(s.sent).toHaveLength(1);
});

test("a device whose verdict changed is posted with what it was", async () => {
  const s = setup([[atk], [{ ...atk, verdict: "doesnt" }]]);
  await s.run();
  await s.run();
  expect(s.sent[0]).toContain("Changed on Devices:\n- **ATK X1 NK 8K** (mouse): Unsupported, was Supported, reported on v3.4.5");
});

test("a stats device that gains a report later is the same device", async () => {
  const s = setup([[probe], [{ ...probe, name: "Probe Mouse Pro", reported: "v3.4.5", boxes: 3 }]]);
  await s.run();
  await s.run();
  expect(s.sent).toEqual([]);
});

test("no channel set, or a list that can't be read, posts nothing", async () => {
  const s = setup([[atk]]);
  s.ctx.config.unset("g", "device_feed_channel_id");
  await s.run();
  const failing = async () => new Response("down", { status: 502 });
  const t = setup([[atk]]);
  await runFeed(t.ctx, "g", async () => null, failing as unknown as typeof fetch);
  await t.run();
  expect([...s.sent, ...t.sent]).toEqual([]);
});

test("feedText says nothing when nothing changed", () => {
  expect(feedText([], [])).toBeNull();
});
