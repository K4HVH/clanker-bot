import { expect, test } from "bun:test";
import {
  clearCheckResult,
  getCheckResult,
  recordCheckFail,
  recordCheckPass,
} from "../../src/db/ticket-check";
import { makeTestDb } from "../helpers/db";

test("a pass is stored and read back", () => {
  const db = makeTestDb();
  expect(getCheckResult(db, "g", "u")).toBeUndefined();
  recordCheckPass(db, "g", "u", 1000);
  expect(getCheckResult(db, "g", "u")).toEqual({ passedAt: 1000, failedAt: null, fails: 0 });
});

test("failures stamp the time and count up", () => {
  const db = makeTestDb();
  recordCheckFail(db, "g", "u", 500);
  expect(getCheckResult(db, "g", "u")).toEqual({ passedAt: null, failedAt: 500, fails: 1 });
  recordCheckFail(db, "g", "u", 900);
  expect(getCheckResult(db, "g", "u")).toEqual({ passedAt: null, failedAt: 900, fails: 2 });
});

// The count is what the mod-log reports as "keeps failing", so it has to mean
// consecutive failures rather than lifetime ones.
test("a pass clears the failure streak", () => {
  const db = makeTestDb();
  recordCheckFail(db, "g", "u", 500);
  recordCheckFail(db, "g", "u", 600);
  recordCheckPass(db, "g", "u", 700);
  expect(getCheckResult(db, "g", "u")).toEqual({ passedAt: 700, failedAt: null, fails: 0 });
});

test("results are per guild and per user", () => {
  const db = makeTestDb();
  recordCheckPass(db, "g1", "u", 100);
  expect(getCheckResult(db, "g2", "u")).toBeUndefined();
  expect(getCheckResult(db, "g1", "other")).toBeUndefined();
});

test("clearing drops the row so the member starts over", () => {
  const db = makeTestDb();
  recordCheckFail(db, "g", "u", 500);
  clearCheckResult(db, "g", "u");
  expect(getCheckResult(db, "g", "u")).toBeUndefined();
});

// With one row stored, a clear that ignored the user id looked identical to one that
// honoured it. /ticket check on one member must not wipe everyone else's.
test("clearing one member leaves the others alone", () => {
  const db = makeTestDb();
  recordCheckPass(db, "g", "alice", 100);
  recordCheckFail(db, "g", "bob", 200);
  recordCheckPass(db, "other-guild", "alice", 300);
  clearCheckResult(db, "g", "alice");
  expect(getCheckResult(db, "g", "alice")).toBeUndefined();
  expect(getCheckResult(db, "g", "bob")?.fails).toBe(1);
  expect(getCheckResult(db, "other-guild", "alice")?.passedAt).toBe(300);
});
