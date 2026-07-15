import { expect, test } from "bun:test";
import { createCase, listCasesByUser } from "../../src/db/cases";
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

test("history lists a user's actions newest first", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "one" });
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "note", reason: "two" });
  const list = listCasesByUser(db, "g1", "u1");
  expect(list.map((c) => c.reason)).toEqual(["two", "one"]);
  expect(list.map((c) => c.caseNumber)).toEqual([2, 1]);
});
