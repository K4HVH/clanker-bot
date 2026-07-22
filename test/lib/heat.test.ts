import { expect, test } from "bun:test";
import { HeatTracker, RepeatTracker, SprayTracker } from "../../src/lib/heat";

const OPTS = { windowMs: 1000, minChars: 5, similarity: 85, channels: 3 };
const rec = (
  s: SprayTracker,
  channelId: string,
  text: string,
  now: number,
  fp: string | null = null,
  opts = OPTS,
) => s.record("g:u", { channelId, text, fp, now }, opts);

test("SprayTracker: same text across N distinct channels in the window trips", () => {
  const s = new SprayTracker();
  expect(rec(s, "c1", "buy crypto now", 0)).toBe(false);
  expect(rec(s, "c2", "buy crypto now", 100)).toBe(false);
  expect(rec(s, "c3", "buy crypto now", 200)).toBe(true); // 3rd distinct channel
});

test("SprayTracker: same channel repeated does NOT trip (needs distinct channels)", () => {
  const s = new SprayTracker();
  rec(s, "c1", "buy crypto now", 0);
  rec(s, "c1", "buy crypto now", 100);
  expect(rec(s, "c1", "buy crypto now", 200)).toBe(false);
});

test("SprayTracker: image-only spray (no text, identical attachment) trips", () => {
  const s = new SprayTracker();
  expect(rec(s, "c1", "", 0, "12345:800:600")).toBe(false);
  expect(rec(s, "c2", "", 100, "12345:800:600")).toBe(false);
  expect(rec(s, "c3", "", 200, "12345:800:600")).toBe(true);
});

test("SprayTracker: short text below minChars is ignored", () => {
  const s = new SprayTracker();
  rec(s, "c1", "gm", 0);
  rec(s, "c2", "gm", 100);
  expect(rec(s, "c3", "gm", 200)).toBe(false); // "gm" < minChars 5
});

test("SprayTracker: near-duplicate text (randomized) still counts", () => {
  const s = new SprayTracker();
  rec(s, "c1", "free nitro claim aaa", 0);
  rec(s, "c2", "free nitro claim aab", 100);
  expect(rec(s, "c3", "free nitro claim aac", 200)).toBe(true); // ~95% similar
});

test("SprayTracker: entries outside the window fall out", () => {
  const s = new SprayTracker();
  rec(s, "c1", "buy crypto now", 0);
  rec(s, "c2", "buy crypto now", 100);
  expect(rec(s, "c3", "buy crypto now", 2000)).toBe(false); // c1/c2 aged out of the 1000ms window
});

test("SprayTracker: unrelated text does not trip", () => {
  const s = new SprayTracker();
  rec(s, "c1", "hello everyone how are you", 0);
  rec(s, "c2", "what time is the meeting", 100);
  expect(rec(s, "c3", "does anyone have the datasheet", 200)).toBe(false);
});

test("flags a burst over the threshold within the window", () => {
  const h = new HeatTracker();
  let hot = false;
  for (let i = 0; i < 4; i++) hot = h.record("g", "u", 100 + i, 1000, 3);
  expect(hot).toBe(true);
});

test("does not flag messages spread beyond the window", () => {
  const h = new HeatTracker();
  expect(h.record("g", "u", 0, 1000, 3)).toBe(false);
  expect(h.record("g", "u", 2000, 1000, 3)).toBe(false);
  expect(h.record("g", "u", 4000, 1000, 3)).toBe(false);
});

test("tracks users independently", () => {
  const h = new HeatTracker();
  h.record("g", "u1", 100, 1000, 1);
  expect(h.record("g", "u2", 100, 1000, 1)).toBe(false);
});

test("RepeatTracker flags a duplicate within the window, not outside it", () => {
  const r = new RepeatTracker();
  expect(r.record("k", "hello", 0, 1000)).toBe(false); // first time
  expect(r.record("k", "HELLO ", 100, 1000)).toBe(true); // same (normalized) within window
  expect(r.record("k", "different", 200, 1000)).toBe(false); // not a repeat
  expect(r.record("k", "hello", 5000, 1000)).toBe(false); // old copy fell out of the window
  expect(r.record("k", "", 300, 1000)).toBe(false); // empty never counts
});
