import { expect, test } from "bun:test";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../src/lib/duration";

test("parses valid durations", () => {
  expect(parseDuration("10m")).toBe(600_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("7d")).toBe(604_800_000);
  expect(parseDuration("1w")).toBe(604_800_000);
});

test("rejects invalid or zero durations", () => {
  expect(parseDuration("nope")).toBeNull();
  expect(parseDuration("0m")).toBeNull();
  expect(parseDuration("")).toBeNull();
});

test("formats round durations", () => {
  expect(formatDuration(600_000)).toBe("10m");
  expect(formatDuration(7_200_000)).toBe("2h");
});

test("28 days is the timeout ceiling", () => {
  expect(parseDuration("29d")).toBeGreaterThan(MAX_TIMEOUT_MS);
  expect(parseDuration("28d")).toBe(MAX_TIMEOUT_MS);
});
