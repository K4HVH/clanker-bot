import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { dropState, getSpecName, loadState, markApplied, putState, setSpecName, stateKey } from "../../src/server/state";

test("state is kept per guild", () => {
  const db = createDatabase(":memory:");
  putState(db, "g1", "channel", "rules", "111");
  putState(db, "g1", "role", "dev", "222");
  putState(db, "g2", "channel", "rules", "333");
  putState(db, "g1", "channel", "rules", "444"); // replaces
  expect(loadState(db, "g1")).toEqual(new Map([[stateKey("channel", "rules"), "444"], [stateKey("role", "dev"), "222"]]));
  dropState(db, "g1", "role", "dev");
  expect(loadState(db, "g1").has(stateKey("role", "dev"))).toBe(false);
  expect(loadState(db, "g2").get(stateKey("channel", "rules"))).toBe("333");
});

test("the spec a guild follows survives an apply mark", () => {
  const db = createDatabase(":memory:");
  expect(getSpecName(db, "g1")).toBeUndefined();
  setSpecName(db, "g1", "medius");
  markApplied(db, "g1", 1234);
  expect(getSpecName(db, "g1")).toBe("medius");
});
