import { expect, test } from "bun:test";
import { RaidDetector } from "../../src/lib/raid";

test("alerts once when joins exceed the threshold, then respects cooldown", () => {
  // Window is wider than the cooldown so the spike stays 'hot' across it.
  const d = new RaidDetector(200_000, 3, 60_000);
  const t = 1_000_000;
  expect(d.record("g", t)).toBe(false); // 1
  expect(d.record("g", t + 1)).toBe(false); // 2
  expect(d.record("g", t + 2)).toBe(false); // 3
  expect(d.record("g", t + 3)).toBe(true); // 4 -> over threshold, first alert
  expect(d.record("g", t + 4)).toBe(false); // still hot, but within cooldown
  expect(d.record("g", t + 70_000)).toBe(true); // still hot, cooldown elapsed -> alert again
});

test("does not alert below the threshold", () => {
  const d = new RaidDetector(10_000, 8, 60_000);
  let alerted = false;
  for (let i = 0; i < 5; i++) alerted = d.record("g", 1000 + i) || alerted;
  expect(alerted).toBe(false);
});
