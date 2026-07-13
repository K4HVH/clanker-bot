import { expect, test } from "bun:test";
import { deleteTag, getTag, listTags, setTag } from "../../src/repositories/tags.repository";
import { makeTestDb } from "../helpers/db";

test("set/get/list/delete with upsert", () => {
  const db = makeTestDb();
  setTag(db, "g", "flash", "Hold BOOT then tap RESET.");
  expect(getTag(db, "g", "flash")).toBe("Hold BOOT then tap RESET.");
  setTag(db, "g", "flash", "Updated.");
  expect(getTag(db, "g", "flash")).toBe("Updated.");
  setTag(db, "g", "wiring", "Check 3V3.");
  expect(listTags(db, "g")).toEqual(["flash", "wiring"]);
  deleteTag(db, "g", "flash");
  expect(getTag(db, "g", "flash")).toBeUndefined();
});
