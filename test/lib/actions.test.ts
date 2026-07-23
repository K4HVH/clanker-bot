import { expect, test } from "bun:test";
import { parseGuardAction, parseScamAction, strongerAction } from "../../src/lib/actions";

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

test("parseScamAction accepts the full set (delete/timeout/kick/ban), falls back to off", () => {
  for (const v of ["flag", "delete", "timeout", "kick", "ban"] as const) {
    expect(parseScamAction(v)).toBe(v);
  }
  expect(parseScamAction("off")).toBe("off");
  expect(parseScamAction("garbage")).toBe("off");
  expect(parseScamAction(null)).toBe("off");
});
