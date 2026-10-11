import { expect, test } from "bun:test";
import { type FeedDevice, runFeed } from "../../src/lib/device-feed";
import { silentContext } from "../helpers/fakes";

const PAGE = "https://medius.k4tech.net/guide/compatibility";
const atk: FeedDevice = { name: "ATK X1 NK 8K", kind: "mouse", verdict: "works", reported: "v3.4.5", url: `${PAGE}/atk-x1-nk-8k` };
const shark: FeedDevice = {
  name: "Attack Shark R5 Ultra",
  kind: "mouse",
  verdict: "partial",
  note: "Over wireless, the vendor's app can't see it",
  reported: "v3.0.1",
  url: `${PAGE}/attack-shark-r5-ultra`,
};
const probe: FeedDevice = { name: "Probe Mouse", kind: "mouse", verdict: "works", vidpid: "1234:abcd", boxes: 2, url: `${PAGE}/probe-mouse` };

interface Sent {
  content: string;
  flags?: number;
}

function setup(lists: (FeedDevice[] | { devices: unknown[]; stats: boolean })[]) {
  const ctx = silentContext();
  ctx.config.set("g", "device_feed_channel_id", "c1");
  const sent: Sent[] = [];
  let call = 0;
  let failAt = -1;
  const fetchList = async () => {
    const next = lists[Math.min(call++, lists.length - 1)]!;
    const body = Array.isArray(next) ? { devices: next, stats: true } : next;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const channel = async (id: string) =>
    id === "c1"
      ? {
          send: async (o: Sent) => {
            if (sent.length === failAt) {
              failAt = -1;
              throw new Error("refused");
            }
            sent.push({ content: o.content, ...(o.flags ? { flags: o.flags } : {}) });
          },
        }
      : null;
  return {
    ctx,
    sent,
    failPart: (n: number) => (failAt = sent.length + n),
    run: () => runFeed(ctx, "g", channel, fetchList as unknown as typeof fetch),
  };
}

test("the first read posts the whole list, silently", async () => {
  const s = setup([[atk, shark]]);
  await s.run();
  expect(s.sent).toEqual([
    {
      content: [
        "On the Devices list:",
        `- [**ATK X1 NK 8K**](<${PAGE}/atk-x1-nk-8k>) (mouse): Supported, reported on v3.4.5`,
        `- [**Attack Shark R5 Ultra**](<${PAGE}/attack-shark-r5-ultra>) (mouse): Partial, reported on v3.0.1. Over wireless, the vendor's app can't see it`,
        `<${PAGE}>`,
      ].join("\n"),
      flags: 4096,
    },
  ]);
  await s.run();
  expect(s.sent).toHaveLength(1);
});

test("a device new to the list is posted, from a report or from the stats", async () => {
  const s = setup([[atk], [atk, shark, probe]]);
  await s.run();
  await s.run();
  expect(s.sent[1]).toEqual({
    content: [
      "Added to Devices:",
      `- [**Attack Shark R5 Ultra**](<${PAGE}/attack-shark-r5-ultra>) (mouse): Partial, reported on v3.0.1. Over wireless, the vendor's app can't see it`,
      `- [**Probe Mouse**](<${PAGE}/probe-mouse>) (mouse): Supported, seen on 2 boxes`,
      `<${PAGE}>`,
    ].join("\n"),
  });
  await s.run();
  expect(s.sent).toHaveLength(2);
});

test("a device whose verdict changed is posted with what it was", async () => {
  const s = setup([[atk], [{ ...atk, verdict: "doesnt" }]]);
  await s.run();
  await s.run();
  expect(s.sent[1]!.content).toContain(`Changed on Devices:\n- [**ATK X1 NK 8K**](<${PAGE}/atk-x1-nk-8k>) (mouse): Unsupported, was Supported, reported on v3.4.5`);
});

test("a stats device that gains a report later is the same device", async () => {
  const s = setup([[probe], [{ ...probe, name: "Probe Mouse Pro", reported: "v3.4.5", boxes: 3 }]]);
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(1);
});

test("a device listed twice is one device, and posts once", async () => {
  const s = setup([[atk], [atk, shark, { ...shark, verdict: "works" }]]);
  await s.run();
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(2);
  expect(s.sent[1]!.content.match(/Attack Shark/g)).toHaveLength(1);
});

test("devices that share a name are told apart by their USB ids", async () => {
  const receiver = (vidpid: string, boxes: number): FeedDevice => ({ name: "USB Receiver", kind: "mouse", verdict: "works", vidpid, boxes });
  const three = [receiver("046d:c539", 2), receiver("046d:c53a", 3), receiver("046d:c547", 8)];
  const s = setup([three, three, [...three, receiver("046d:c54d", 17)], [...three, { ...receiver("046d:c54d", 17), verdict: "doesnt" }]]);
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(1);
  await s.run();
  expect(s.sent[1]!.content).toBe("Added to Devices:\n- **USB Receiver** (mouse): Supported, seen on 17 boxes\n<https://medius.k4tech.net/guide/compatibility>");
  await s.run();
  expect(s.sent[2]!.content).toContain("Changed on Devices:\n- **USB Receiver** (mouse): Unsupported, was Supported, seen on 17 boxes");
  expect(s.sent).toHaveLength(3);
});

test("a reported device keeps its place when the usage stats are down and its USB id goes with them", async () => {
  const s = setup([[{ ...atk, vidpid: "373b:1001", boxes: 4 }], { devices: [atk], stats: false }, [{ ...atk, vidpid: "373b:1001", boxes: 5 }]]);
  await s.run();
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(1);
});

test("a reported device whose USB id moves to another of its ids isn't posted again", async () => {
  const razer = (vidpid: string): FeedDevice => ({ name: "Razer X", kind: "mouse", verdict: "works", reported: "v3.4.5", vidpid, boxes: 4 });
  const s = setup([[razer("1532:00c0")], [razer("1532:00c1")], { devices: [{ ...razer("x"), vidpid: undefined }], stats: false }]);
  await s.run();
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(1);
});

test("a renamed report stays known, through a stats outage after", async () => {
  const foo: FeedDevice = { name: "Foo", kind: "mouse", verdict: "works", vidpid: "1111:2222", reported: "v3.4.5" };
  const pro: FeedDevice = { ...foo, name: "Foo Pro" };
  const { vidpid: _, ...proDown } = pro;
  const s = setup([[foo], [pro], { devices: [proDown], stats: false }]);
  await s.run();
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(1);
});

test("a report taking over a stats device posts its verdict once, whichever id it carries", async () => {
  const w: FeedDevice = { name: "Bar", kind: "mouse", verdict: "works", vidpid: "aaaa:0001", boxes: 3 };
  const v: FeedDevice = { ...w, vidpid: "bbbb:0002", boxes: 5 };
  const rep: FeedDevice = { name: "Bar", kind: "mouse", verdict: "partial", vidpid: "bbbb:0002", reported: "v3.4.5", boxes: 8 };
  const { vidpid: _, ...repDown } = rep;
  const s = setup([[w, v], [rep], { devices: [repDown], stats: false }, [{ ...rep, vidpid: "aaaa:0001" }]]);
  await s.run();
  await s.run();
  expect(s.sent[1]!.content).toBe("Changed on Devices:\n- **Bar** (mouse): Partial, was Supported, reported on v3.4.5\n<https://medius.k4tech.net/guide/compatibility>");
  await s.run();
  await s.run();
  expect(s.sent).toHaveLength(2);
});

test("a device's name can't carry markdown into the post", async () => {
  const odd: FeedDevice = { name: "**Big** [x](https://bad.example) ]", kind: "mouse", verdict: "works", vidpid: "1:1", boxes: 2, url: `${PAGE}/odd` };
  const s = setup([[odd]]);
  await s.run();
  expect(s.sent[0]!.content).toContain(`- [**\\*\\*Big\\*\\* \\[x\\](https://bad.example) \\]**](<${PAGE}/odd>) (mouse)`);
});

test("a line longer than a message is cut to fit, so the read still finishes", async () => {
  const wordy: FeedDevice = { name: "Wordy", kind: "mouse", verdict: "works", reported: "v3.4.5", note: "n".repeat(2500) };
  const s = setup([[atk, wordy]]);
  await s.run();
  expect(s.sent.every((m) => m.content.length <= 2000)).toBe(true);
  expect(s.sent.map((m) => m.content).join("\n")).toContain("**Wordy**");
  await s.run();
  expect(s.sent.length).toBeLessThanOrEqual(2);
});

test("a long post goes out in parts, and a part that fails is posted again with only what it carried", async () => {
  const many = Array.from({ length: 60 }, (_, i): FeedDevice => ({ name: `Mouse number ${i} with a long name`, kind: "mouse", verdict: "works", reported: "v3.4.5", url: `${PAGE}/m${i}` }));
  const s = setup([[atk], [atk, ...many]]);
  await s.run();
  s.failPart(1); // the second part of the next post
  await s.run().catch(() => {});
  const firstPart = s.sent.length - 1;
  expect(firstPart).toBeGreaterThanOrEqual(1);
  await s.run();
  const all = s.sent.slice(1).map((m) => m.content).join("\n");
  for (const d of many) expect(all.split(`**${d.name}**`).length - 1).toBe(1);
  expect(s.sent.slice(1).every((m) => m.content.length <= 2000)).toBe(true);
});

test("entries the feed can't read are left out", async () => {
  const s = setup([[atk, { name: "", kind: "mouse", verdict: "works" }, { name: "Odd", kind: "mouse", verdict: "maybe" }] as unknown as FeedDevice[]]);
  await s.run();
  expect(s.sent[0]!.content).not.toContain("Odd");
  expect(s.sent[0]!.content).toContain("ATK X1 NK 8K");
});

test("an empty list, or one without the usage stats, isn't taken as the first read", async () => {
  const s = setup([[], { devices: [atk], stats: false }, [atk, probe]]);
  await s.run();
  await s.run();
  expect(s.sent).toEqual([]);
  await s.run();
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]!.content).toContain("On the Devices list:");
  expect(s.sent[0]!.content).toContain("Probe Mouse");
});

test("no channel set, or a list that can't be read, posts nothing", async () => {
  const s = setup([[atk]]);
  s.ctx.config.unset("g", "device_feed_channel_id");
  await s.run();
  const failing = async () => new Response("down", { status: 502 });
  await runFeed(s.ctx, "g", async () => null, failing as unknown as typeof fetch);
  expect(s.sent).toEqual([]);
});

test("a first post stopped part way carries on with what's left", async () => {
  const many = Array.from({ length: 60 }, (_, i): FeedDevice => ({ name: `Mouse number ${i} with a long name`, kind: "mouse", verdict: "works", reported: "v3.4.5", url: `${PAGE}/m${i}` }));
  const s = setup([many]);
  let calls = 0;
  const flaky = {
    send: async (o: Sent) => {
      if (++calls === 2) throw new Error("refused");
      s.sent.push({ content: o.content, ...(o.flags ? { flags: o.flags } : {}) });
    },
  };
  const list = async () => new Response(JSON.stringify({ devices: many, stats: true }), { status: 200 });
  await runFeed(s.ctx, "g", async () => flaky, list as unknown as typeof fetch).catch(() => {});
  await runFeed(s.ctx, "g", async () => flaky, list as unknown as typeof fetch);
  const all = s.sent.map((m) => m.content).join("\n");
  for (const d of many) expect(all.split(`**${d.name}**`).length - 1).toBe(1);
});
