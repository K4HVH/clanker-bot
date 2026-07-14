import { expect, test } from "bun:test";
import {
  createCase,
  getCaseByNumber,
  listCasesByUser,
} from "../../src/db/cases";
import { makeTestDb } from "../helpers/db";

test("case numbers increment sequentially per guild", () => {
  const db = makeTestDb();
  const a = createCase(db, {
    guildId: "g1",
    userId: "u1",
    moderatorId: "m",
    type: "warn",
    reason: "r",
  });
  const b = createCase(db, {
    guildId: "g1",
    userId: "u2",
    moderatorId: "m",
    type: "warn",
    reason: "r",
  });
  expect(a.caseNumber).toBe(1);
  expect(b.caseNumber).toBe(2);
});

test("case numbering is isolated per guild", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "r" });
  const other = createCase(db, {
    guildId: "g2",
    userId: "u1",
    moderatorId: "m",
    type: "warn",
    reason: "r",
  });
  expect(other.caseNumber).toBe(1);
});

test("fetch by number and list by user (newest first)", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "one" });
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "note", reason: "two" });
  expect(getCaseByNumber(db, "g1", 1)?.reason).toBe("one");
  const list = listCasesByUser(db, "g1", "u1");
  expect(list.map((c) => c.caseNumber)).toEqual([2, 1]);
});
