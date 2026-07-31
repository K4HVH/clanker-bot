import { expect, test } from "bun:test";
import {
  deleteChallenge,
  getChallenge,
  pruneExpiredChallenges,
  setChallenge,
  setChallengeDmMessage,
} from "../../src/db/verification";
import { makeTestDb } from "../helpers/db";

test("set/get/delete a challenge with upsert", () => {
  const db = makeTestDb();
  setChallenge(db, "g", "u", "ABC123", 100, 0);
  expect(getChallenge(db, "g", "u")).toEqual({
    code: "ABC123",
    expiresAt: 100,
    attempts: 0,
    dmMessageId: undefined,
  });
  setChallenge(db, "g", "u", "XYZ789", 200, 0);
  expect(getChallenge(db, "g", "u")?.code).toBe("XYZ789");
  deleteChallenge(db, "g", "u");
  expect(getChallenge(db, "g", "u")).toBeUndefined();
});

test("attempts: the shared budget is written by setChallenge and read back", () => {
  const db = makeTestDb();
  // A fresh challenge starts the shared budget at 0.
  setChallenge(db, "g", "u", "ABC123", 100, 0);
  expect(getChallenge(db, "g", "u")?.attempts).toBe(0);

  // A wrong guess rotates the code AND persists the incremented count in one write, so the
  // budget is shared across surfaces (a DM wrong guess is seen by the in-channel flow).
  setChallenge(db, "g", "u", "XYZ789", 100, 2);
  const c = getChallenge(db, "g", "u");
  expect(c?.code).toBe("XYZ789");
  expect(c?.attempts).toBe(2);
});

test("dm_message_id: persists, survives code rotation, and clears on delete", () => {
  const db = makeTestDb();
  // A brand-new challenge starts with no anchor.
  setChallenge(db, "g", "u", "ABC123", 100, 0);
  expect(getChallenge(db, "g", "u")?.dmMessageId).toBeUndefined();

  // The on-join flow records which DM message holds the captcha.
  setChallengeDmMessage(db, "g", "u", "555000111222333444");
  expect(getChallenge(db, "g", "u")?.dmMessageId).toBe("555000111222333444");

  // Rotating the code (wrong guess / New Code) MUST NOT clobber the anchor: the fix that
  // revives a DM after a restart depends on this surviving every rotation.
  setChallenge(db, "g", "u", "XYZ789", 100, 1);
  const rotated = getChallenge(db, "g", "u");
  expect(rotated?.code).toBe("XYZ789");
  expect(rotated?.attempts).toBe(1);
  expect(rotated?.dmMessageId).toBe("555000111222333444");

  // A solved/abandoned challenge takes the anchor with it.
  deleteChallenge(db, "g", "u");
  expect(getChallenge(db, "g", "u")).toBeUndefined();
});

test("pruneExpiredChallenges removes only rows past their TTL", () => {
  const db = makeTestDb();
  setChallenge(db, "g", "old", "AAA111", 100, 0);
  setChallenge(db, "g", "live", "BBB222", 5000, 0);
  const removed = pruneExpiredChallenges(db, 1000);
  expect(removed).toBe(1);
  expect(getChallenge(db, "g", "old")).toBeUndefined();
  expect(getChallenge(db, "g", "live")?.code).toBe("BBB222");
});
