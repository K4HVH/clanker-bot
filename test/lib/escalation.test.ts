import { expect, test } from "bun:test";
import { type EscalationThresholds, escalationActionFor } from "../../src/lib/escalation";

const T: EscalationThresholds = {
  shortScore: 3,
  longScore: 5,
  kickScore: 8,
  banScore: 12,
  shortMs: 3_600_000,
  longMs: 86_400_000,
};

test("maps score bands to actions", () => {
  expect(escalationActionFor(0, T)).toBeNull();
  expect(escalationActionFor(2, T)).toBeNull();
  expect(escalationActionFor(3, T)).toEqual({ type: "timeout", durationMs: 3_600_000 });
  expect(escalationActionFor(5, T)).toEqual({ type: "timeout", durationMs: 86_400_000 });
  expect(escalationActionFor(8, T)).toEqual({ type: "kick" });
  expect(escalationActionFor(12, T)).toEqual({ type: "ban" });
});

test("respects custom thresholds", () => {
  const custom: EscalationThresholds = { ...T, banScore: 100, kickScore: 50 };
  expect(escalationActionFor(12, custom)).toEqual({ type: "timeout", durationMs: 86_400_000 });
  expect(escalationActionFor(50, custom)).toEqual({ type: "kick" });
});
