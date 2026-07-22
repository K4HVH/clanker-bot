import { expect, test } from "bun:test";
import { canAct } from "../../src/lib/mod-action";

const base = {
  mePos: 10,
  meHasPerm: true,
  targetPos: 5,
  userId: "u",
  ownerId: "owner",
};

test("canAct: all conditions met", () => {
  expect(canAct(base)).toBe(true);
});

test("canAct: bot not in guild (mePos null) can't act", () => {
  expect(canAct({ ...base, mePos: null })).toBe(false);
});

test("canAct: unresolved target (targetPos null) can't act", () => {
  expect(canAct({ ...base, targetPos: null })).toBe(false);
});

test("canAct: never acts on the guild owner", () => {
  expect(canAct({ ...base, userId: "owner" })).toBe(false);
});

test("canAct: won't act on an equal-or-higher role", () => {
  expect(canAct({ ...base, targetPos: 10 })).toBe(false); // equal
  expect(canAct({ ...base, targetPos: 11 })).toBe(false); // higher
});

test("canAct: missing permission can't act", () => {
  expect(canAct({ ...base, meHasPerm: false })).toBe(false);
});
