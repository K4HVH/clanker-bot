import { expect, test } from "bun:test";
import { RaidDetector } from "../../src/lib/raid";

test("alerts once when joins exceed the threshold, then respects cooldown", () => {
  const d = new RaidDetector();
  const t = 1_000_000;
  // Window (200s) wider than the cooldown (60s) so the spike stays 'hot' across it.
  const rec = (now: number) => d.record("g", now, 200_000, 3, 60_000);
  expect(rec(t)).toBe(false);
  expect(rec(t + 1)).toBe(false);
  expect(rec(t + 2)).toBe(false);
  expect(rec(t + 3)).toBe(true); // over threshold -> first alert
  expect(rec(t + 4)).toBe(false); // still hot, within cooldown
  expect(rec(t + 70_000)).toBe(true); // still hot, cooldown elapsed -> alert again
});

test("does not alert below the threshold", () => {
  const d = new RaidDetector();
  let alerted = false;
  for (let i = 0; i < 5; i++) alerted = d.record("g", 1000 + i, 10_000, 8, 60_000) || alerted;
  expect(alerted).toBe(false);
});
