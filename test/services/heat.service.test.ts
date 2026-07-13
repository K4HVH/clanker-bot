import { expect, test } from "bun:test";
import { HeatTracker } from "../../src/services/heat.service";

test("flags a burst over the threshold within the window", () => {
  const h = new HeatTracker(1_000, 3);
  let hot = false;
  for (let i = 0; i < 4; i++) hot = h.record("g", "u", 100 + i);
  expect(hot).toBe(true);
});

test("does not flag messages spread beyond the window", () => {
  const h = new HeatTracker(1_000, 3);
  expect(h.record("g", "u", 0)).toBe(false);
  expect(h.record("g", "u", 2_000)).toBe(false);
  expect(h.record("g", "u", 4_000)).toBe(false);
});

test("tracks users independently", () => {
  const h = new HeatTracker(1_000, 1);
  h.record("g", "u1", 100);
  expect(h.record("g", "u2", 100)).toBe(false);
});
