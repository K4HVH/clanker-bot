import { expect, test } from "bun:test";
import {
  parseBlocklistAction,
  parseGuardAction,
  parseSprayAction,
  strongerAction,
} from "../../src/lib/actions";

test("strongerAction picks the harshest (ban > kick > flag > off)", () => {
  expect(strongerAction("off", "flag")).toBe("flag");
  expect(strongerAction("flag", "kick")).toBe("kick");
  expect(strongerAction("kick", "ban")).toBe("ban");
  expect(strongerAction("ban", "flag")).toBe("ban");
  expect(strongerAction("off", "off")).toBe("off");
});

test("parseGuardAction accepts its values and falls back to off", () => {
  for (const v of ["flag", "kick", "ban"] as const) expect(parseGuardAction(v)).toBe(v);
  expect(parseGuardAction("off")).toBe("off");
  expect(parseGuardAction("timeout")).toBe("off"); // not a guard action
  expect(parseGuardAction(undefined)).toBe("off");
  expect(parseGuardAction("garbage")).toBe("off");
});

test("parseSprayAction includes timeout, rejects delete", () => {
  for (const v of ["flag", "timeout", "kick", "ban"] as const) expect(parseSprayAction(v)).toBe(v);
  expect(parseSprayAction("delete")).toBe("off");
  expect(parseSprayAction(null)).toBe("off");
});

test("parseBlocklistAction includes delete, rejects timeout/kick", () => {
  for (const v of ["flag", "delete", "ban"] as const) expect(parseBlocklistAction(v)).toBe(v);
  expect(parseBlocklistAction("timeout")).toBe("off");
  expect(parseBlocklistAction("kick")).toBe("off");
});
