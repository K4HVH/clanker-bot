import { expect, test } from "bun:test";
import { computeActiveScore } from "../../src/services/infractions.service";

const NOW = 1_000 * 86_400_000; // day 1000 in ms

test("sums weights within the decay window", () => {
  const cases = [
    { type: "warn", createdAt: NOW - 1_000 }, // recent, +1
    { type: "timeout", createdAt: NOW - 1_000 }, // recent, +2
    { type: "note", createdAt: NOW - 1_000 }, // +0
  ];
  expect(computeActiveScore(cases, NOW, 90)).toBe(3);
});

test("ignores cases older than the decay window", () => {
  const old = NOW - 100 * 86_400_000; // 100 days ago
  const cases = [
    { type: "warn", createdAt: old },
    { type: "kick", createdAt: NOW - 1_000 },
  ];
  expect(computeActiveScore(cases, NOW, 90)).toBe(3); // only the kick counts
});

test("auto-applied cases do not count toward the score", () => {
  const cases = [
    { type: "warn", createdAt: NOW - 1_000 },
    { type: "kick", createdAt: NOW - 1_000, meta: '{"auto":true}' },
  ];
  expect(computeActiveScore(cases, NOW, 90)).toBe(1); // only the manual warn
});
