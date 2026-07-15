import { expect, test } from "bun:test";
import { HeatTracker, RepeatTracker } from "../../src/lib/heat";

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
