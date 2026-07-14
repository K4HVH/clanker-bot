import { expect, test } from "bun:test";
import {
  deleteChallenge,
  getChallenge,
  pruneExpiredChallenges,
  setChallenge,
} from "../../src/db/verification";
import { makeTestDb } from "../helpers/db";

test("set/get/delete a challenge with upsert", () => {
  const db = makeTestDb();
  setChallenge(db, "g", "u", "ABC123", 100);
  expect(getChallenge(db, "g", "u")).toEqual({ code: "ABC123", expiresAt: 100 });
  setChallenge(db, "g", "u", "XYZ789", 200);
  expect(getChallenge(db, "g", "u")?.code).toBe("XYZ789");
  deleteChallenge(db, "g", "u");
  expect(getChallenge(db, "g", "u")).toBeUndefined();
});

test("pruneExpiredChallenges removes only rows past their TTL", () => {
  const db = makeTestDb();
  setChallenge(db, "g", "old", "AAA111", 100);
  setChallenge(db, "g", "live", "BBB222", 5000);
  const removed = pruneExpiredChallenges(db, 1000);
  expect(removed).toBe(1);
  expect(getChallenge(db, "g", "old")).toBeUndefined();
  expect(getChallenge(db, "g", "live")?.code).toBe("BBB222");
});
