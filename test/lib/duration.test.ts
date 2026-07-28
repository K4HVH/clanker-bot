import { expect, test } from "bun:test";
import {
  formatDuration,
  formatElapsed,
  MAX_TIMEOUT_MS,
  parseDuration,
} from "../../src/lib/duration";

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

test("formatElapsed reads as prose, keeping the two largest non-zero units", () => {
  expect(formatElapsed(0)).toBe("less than a minute");
  expect(formatElapsed(59_000)).toBe("less than a minute");
  expect(formatElapsed(60_000)).toBe("1 minute");
  expect(formatElapsed(5_400_000)).toBe("1 hour, 30 minutes");
  expect(formatElapsed(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 days, 4 hours");
  // Trailing precision below the second unit is dropped, not rounded up into it.
  expect(formatElapsed(3 * 86_400_000 + 4 * 3_600_000 + 59_000)).toBe("3 days, 4 hours");
  expect(formatElapsed(400 * 86_400_000)).toBe("1 year, 35 days");
  // A join timestamp ahead of the leave (clock skew) must not render as negative prose.
  expect(formatElapsed(-5_000)).toBe("less than a minute");
});
