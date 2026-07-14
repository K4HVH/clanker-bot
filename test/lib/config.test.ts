import { expect, test } from "bun:test";
import { ConfigService } from "../../src/lib/config";
import { makeTestDb } from "../helpers/db";

test("typed get/set round-trips", () => {
  const cfg = new ConfigService(makeTestDb());
  expect(cfg.get<string>("g1", "chan")).toBeUndefined();
  cfg.set("g1", "chan", "123");
  expect(cfg.get<string>("g1", "chan")).toBe("123");
  cfg.set("g1", "flag", true);
  expect(cfg.get<boolean>("g1", "flag")).toBe(true);
});

test("unset clears the value", () => {
  const cfg = new ConfigService(makeTestDb());
  cfg.set("g1", "chan", "123");
  cfg.unset("g1", "chan");
  expect(cfg.get<string>("g1", "chan")).toBeUndefined();
});

test("all returns parsed values", () => {
  const cfg = new ConfigService(makeTestDb());
  cfg.set("g1", "a", "x");
  cfg.set("g1", "b", 2);
  expect(cfg.all("g1")).toEqual({ a: "x", b: 2 });
});
