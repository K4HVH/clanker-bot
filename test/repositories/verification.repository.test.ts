import { expect, test } from "bun:test";
import {
  deleteChallenge,
  getChallenge,
  setChallenge,
} from "../../src/repositories/verification.repository";
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
