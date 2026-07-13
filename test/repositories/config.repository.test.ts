import { expect, test } from "bun:test";
import {
  deleteConfigRow,
  getConfigRow,
  listConfigRows,
  setConfigRow,
} from "../../src/repositories/config.repository";
import { makeTestDb } from "../helpers/db";

test("set then get round-trips a raw value with upsert semantics", () => {
  const db = makeTestDb();
  setConfigRow(db, "g1", "k", '"a"', 1);
  expect(getConfigRow(db, "g1", "k")).toBe('"a"');
  setConfigRow(db, "g1", "k", '"b"', 2);
  expect(getConfigRow(db, "g1", "k")).toBe('"b"');
});

test("list and delete", () => {
  const db = makeTestDb();
  setConfigRow(db, "g1", "a", "1", 1);
  setConfigRow(db, "g1", "b", "2", 1);
  expect(listConfigRows(db, "g1").length).toBe(2);
  deleteConfigRow(db, "g1", "a");
  expect(getConfigRow(db, "g1", "a")).toBeUndefined();
});
