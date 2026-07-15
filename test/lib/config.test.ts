import { expect, test } from "bun:test";
import {
  CATEGORIES,
  CONFIG_KEYS,
  ConfigService,
  REGISTRY,
  REGISTRY_BY_KEY,
  validateSetting,
} from "../../src/lib/config";
import { makeTestDb } from "../helpers/db";

test("registry covers every CONFIG_KEYS value and vice versa, with no duplicates", () => {
  const keyValues = new Set<string>(Object.values(CONFIG_KEYS));
  const registryKeys = new Set(REGISTRY.map((s) => s.key));
  expect(registryKeys.size).toBe(REGISTRY.length);
  for (const k of keyValues) expect(registryKeys.has(k)).toBe(true);
  for (const k of registryKeys) expect(keyValues.has(k)).toBe(true);
});

test("every setting has a known category and JSON-safe defaults", () => {
  const catIds = new Set(CATEGORIES.map((c) => c.id));
  for (const s of REGISTRY) {
    expect(catIds.has(s.category)).toBe(true);
    if (s.default !== undefined) {
      expect(JSON.parse(JSON.stringify(s.default))).toEqual(s.default);
    }
    if (s.type === "int") expect(typeof s.default).toBe("number");
    if (s.type === "bool") expect(typeof s.default).toBe("boolean");
  }
});

test("getEffective falls back to default; get stays unset-sensitive", () => {
  const cfg = new ConfigService(makeTestDb());
  expect(cfg.getEffective<boolean>("g", CONFIG_KEYS.dmOnAction)).toBe(false);
  expect(cfg.get<boolean>("g", CONFIG_KEYS.dmOnAction)).toBeUndefined();
  expect(cfg.getEffective<number>("g", CONFIG_KEYS.automodSpamWindowSeconds)).toBe(7);
  cfg.set("g", CONFIG_KEYS.dmOnAction, true);
  expect(cfg.getEffective<boolean>("g", CONFIG_KEYS.dmOnAction)).toBe(true);
});

test("reset clears all rows for the guild", () => {
  const cfg = new ConfigService(makeTestDb());
  cfg.set("g", CONFIG_KEYS.dmOnAction, true);
  cfg.set("g", CONFIG_KEYS.automodSpam, true);
  expect(cfg.reset("g")).toBe(2);
  expect(cfg.get("g", CONFIG_KEYS.dmOnAction)).toBeUndefined();
});

test("validateSetting enforces type and bounds", () => {
  const boolS = REGISTRY_BY_KEY.get(CONFIG_KEYS.dmOnAction);
  const intS = REGISTRY_BY_KEY.get(CONFIG_KEYS.automodMentionLimit); // min 1 max 50
  const chanS = REGISTRY_BY_KEY.get(CONFIG_KEYS.modLogChannelId);
  if (!boolS || !intS || !chanS) throw new Error("registry missing keys");
  expect(validateSetting(boolS, true)).toBe(true);
  expect(validateSetting(boolS, "yes")).toBe(false);
  expect(validateSetting(intS, 5)).toBe(true);
  expect(validateSetting(intS, 0)).toBe(false);
  expect(validateSetting(intS, 51)).toBe(false);
  expect(validateSetting(intS, 5.5)).toBe(false);
  expect(validateSetting(chanS, "123456789012345678")).toBe(true);
  expect(validateSetting(chanS, "abc")).toBe(false);
});

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
