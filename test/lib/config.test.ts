import { expect, test } from "bun:test";
import {
  CATEGORIES,
  CONFIG_KEYS,
  coerceSetting,
  ConfigService,
  migrateConfig,
  parseRoleIds,
  REGISTRY,
  REGISTRY_BY_KEY,
  validateSetting,
} from "../../src/lib/config";
import { makeTestDb } from "../helpers/db";

test("migrateConfig renames old keys, drops removed ones, and is idempotent", () => {
  const db = makeTestDb();
  const cfg = new ConfigService(db);
  cfg.set("g", "automod_timeout_minutes", 30);
  cfg.set("g", "autoban_delete_hours", 48);
  cfg.set("g", "antiscam_blocklist_action", "ban");
  cfg.set("g", "antiscam_spray_purge", true); // removed key
  cfg.set("g", "honeypot_delete_hours", 12); // removed key

  migrateConfig(db);
  expect(cfg.get<number>("g", "timeout_minutes")).toBe(30);
  expect(cfg.get<number>("g", "automod_timeout_minutes")).toBeUndefined();
  expect(cfg.get<number>("g", "auto_wipe_hours")).toBe(48);
  expect(cfg.get<number>("g", "autoban_delete_hours")).toBeUndefined();
  expect(cfg.get<string>("g", "scam_signature_action")).toBe("ban");
  expect(cfg.get<string>("g", "antiscam_blocklist_action")).toBeUndefined();
  expect(cfg.get<boolean>("g", "antiscam_spray_purge")).toBeUndefined();
  expect(cfg.get<number>("g", "honeypot_delete_hours")).toBeUndefined();

  migrateConfig(db); // idempotent
  expect(cfg.get<number>("g", "timeout_minutes")).toBe(30);
});

test("migrateConfig does not overwrite an already-migrated value", () => {
  const db = makeTestDb();
  const cfg = new ConfigService(db);
  cfg.set("g", "automod_timeout_minutes", 5); // old
  cfg.set("g", "timeout_minutes", 99); // new already set
  migrateConfig(db);
  expect(cfg.get<number>("g", "timeout_minutes")).toBe(99); // kept
  expect(cfg.get<number>("g", "automod_timeout_minutes")).toBeUndefined(); // old dropped
});

test("registry covers every CONFIG_KEYS value and vice versa, with no duplicates", () => {
  const keyValues = new Set<string>(Object.values(CONFIG_KEYS));
  const registryKeys = new Set(REGISTRY.map((s) => s.key));
  expect(registryKeys.size).toBe(REGISTRY.length);
  for (const k of keyValues) expect(registryKeys.has(k)).toBe(true);
  for (const k of registryKeys) expect(keyValues.has(k)).toBe(true);
});

test("every setting has a non-empty description", () => {
  for (const s of REGISTRY) {
    expect(typeof s.description).toBe("string");
    expect((s.description ?? "").length).toBeGreaterThan(0);
  }
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

test("honeypot + scam removal actions default to off", () => {
  for (const key of [
    CONFIG_KEYS.honeypotAction,
    CONFIG_KEYS.scamSprayAction,
    CONFIG_KEYS.scamSignatureAction,
  ]) {
    expect(REGISTRY_BY_KEY.get(key)?.default).toBe("off");
  }
  // The self-seeding writer must be opt-in.
  expect(REGISTRY_BY_KEY.get(CONFIG_KEYS.scamSeedFromHoneypot)?.default).toBe(false);
  // The scam categories exist under the Automod prefix.
  const catIds = new Set(CATEGORIES.map((c) => c.id));
  for (const id of ["honeypot", "automod-scam", "automod-scam-seed"]) {
    expect(catIds.has(id)).toBe(true);
  }
});

test("getEffective falls back to default; get stays unset-sensitive", () => {
  const cfg = new ConfigService(makeTestDb());
  expect(cfg.getEffective<boolean>("g", CONFIG_KEYS.dmOnAction)).toBe(false);
  expect(cfg.get<boolean>("g", CONFIG_KEYS.dmOnAction)).toBeUndefined();
  expect(cfg.getEffective<number>("g", CONFIG_KEYS.automodFloodSeconds)).toBe(7);
  cfg.set("g", CONFIG_KEYS.dmOnAction, true);
  expect(cfg.getEffective<boolean>("g", CONFIG_KEYS.dmOnAction)).toBe(true);
});

test("reset clears all rows for the guild", () => {
  const cfg = new ConfigService(makeTestDb());
  cfg.set("g", CONFIG_KEYS.dmOnAction, true);
  cfg.set("g", CONFIG_KEYS.automodFlood, true);
  expect(cfg.reset("g")).toBe(2);
  expect(cfg.get("g", CONFIG_KEYS.dmOnAction)).toBeUndefined();
});

test("validateSetting enforces type and bounds", () => {
  const boolS = REGISTRY_BY_KEY.get(CONFIG_KEYS.dmOnAction);
  const intS = REGISTRY_BY_KEY.get(CONFIG_KEYS.automodFloodMessages); // min 2 max 30
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

  const choiceS = REGISTRY_BY_KEY.get(CONFIG_KEYS.accountAgeGateAction);
  if (!choiceS) throw new Error("registry missing choice key");
  expect(validateSetting(choiceS, "kick")).toBe(true);
  expect(validateSetting(choiceS, "off")).toBe(true);
  expect(validateSetting(choiceS, "explode")).toBe(false); // not an offered choice
  expect(validateSetting(choiceS, true)).toBe(false);
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

// ── multi-select settings (role pickers, category pickers) ──────────────────

test("validateSetting accepts a list of role IDs and rejects anything else", () => {
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.ticketCheckExemptRoles);
  if (!roles) throw new Error("registry missing the exempt roles key");
  expect(roles.type).toBe("roles");
  expect(validateSetting(roles, [])).toBe(true);
  expect(validateSetting(roles, ["123456789012345678"])).toBe(true);
  expect(validateSetting(roles, ["123456789012345678", "987654321098765432"])).toBe(true);
  expect(validateSetting(roles, ["nope"])).toBe(false);
  expect(validateSetting(roles, "123456789012345678")).toBe(false); // a bare string is not a list
  expect(validateSetting(roles, [123456789012345678])).toBe(false);
});

test("validateSetting holds a multi-choice list to the offered values", () => {
  const cats = REGISTRY_BY_KEY.get(CONFIG_KEYS.ticketCheckCategories);
  if (!cats) throw new Error("registry missing the categories key");
  expect(cats.type).toBe("multichoice");
  expect(validateSetting(cats, ["reasoning"])).toBe(true);
  expect(validateSetting(cats, [])).toBe(true);
  expect(validateSetting(cats, ["reasoning", "made-up"])).toBe(false);
  expect(validateSetting(cats, "reasoning")).toBe(false);
});

test("parseRoleIds reads a stored list, and still reads a hand-typed one", () => {
  expect(parseRoleIds(["123456789012345678", "987654321098765432"])).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
  expect(parseRoleIds(["123456789012345678", "nonsense"])).toEqual(["123456789012345678"]);
  // Values typed in before the picker existed, and old config exports, are still lists
  // of IDs in a string.
  expect(parseRoleIds("123456789012345678, 987654321098765432")).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
  expect(parseRoleIds(undefined)).toEqual([]);
  expect(parseRoleIds([])).toEqual([]);
});

test("migrateConfig turns hand-typed role lists into picker lists", () => {
  const db = makeTestDb();
  const cfg = new ConfigService(db);
  cfg.set("g", CONFIG_KEYS.honeypotExemptRoles, "123456789012345678, 987654321098765432");
  cfg.set("g2", CONFIG_KEYS.ticketCheckExemptRoles, "nonsense");
  migrateConfig(db);
  expect(cfg.get<string[]>("g", CONFIG_KEYS.honeypotExemptRoles)).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
  expect(cfg.get<string[]>("g2", CONFIG_KEYS.ticketCheckExemptRoles)).toEqual([]);
  // Idempotent: a second pass leaves the migrated list alone.
  migrateConfig(db);
  expect(cfg.get<string[]>("g", CONFIG_KEYS.honeypotExemptRoles)).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
});

// A config exported before those settings became pickers holds them as a typed string.
// Validation rejects that shape, and import reports a rejection only as a count, so a
// restored backup would come back quietly missing its honeypot exemptions.
test("coerceSetting brings an older export's values up to the current shape", () => {
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!;
  expect(coerceSetting(roles, "123456789012345678, 987654321098765432")).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
  // Junk is left alone rather than coerced to an empty list, so validation refuses it and
  // the admin is told, instead of the setting being quietly emptied.
  expect(coerceSetting(roles, "nonsense")).toBe("nonsense");
  expect(validateSetting(roles, coerceSetting(roles, "nonsense"))).toBe(false);

  const cats = REGISTRY_BY_KEY.get(CONFIG_KEYS.ticketCheckCategories)!;
  expect(coerceSetting(cats, "reasoning")).toEqual(["reasoning"]);
  expect(coerceSetting(cats, "reasoning, made-up")).toEqual(["reasoning"]);
});

test("coerceSetting leaves anything already in the right shape alone", () => {
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!;
  expect(coerceSetting(roles, ["123456789012345678"])).toEqual(["123456789012345678"]);
  const bool = REGISTRY_BY_KEY.get(CONFIG_KEYS.dmOnAction)!;
  expect(coerceSetting(bool, true)).toBe(true);
  const int = REGISTRY_BY_KEY.get(CONFIG_KEYS.automodFloodMessages)!;
  expect(coerceSetting(int, 5)).toBe(5);
});

test("an older export now survives the round trip that import puts it through", () => {
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!;
  const legacy = "123456789012345678, 987654321098765432";
  expect(validateSetting(roles, legacy)).toBe(false); // why it was being dropped
  expect(validateSetting(roles, coerceSetting(roles, legacy))).toBe(true);
});

// ── defects found by adversarial review ─────────────────────────────────────

// One unreadable row used to abort the whole transaction, rolling back unrelated renames
// and throwing at boot, which the entry point does not catch.
test("migrateConfig survives a row it cannot parse", () => {
  const db = makeTestDb();
  db.query("INSERT INTO guild_config (guild_id,key,value,updated_at) VALUES (?,?,?,?)").run(
    "g",
    CONFIG_KEYS.honeypotExemptRoles,
    "not json",
    1,
  );
  db.query("INSERT INTO guild_config (guild_id,key,value,updated_at) VALUES (?,?,?,?)").run(
    "g",
    "antiscam_spray_action",
    '"kick"',
    1,
  );
  expect(() => migrateConfig(db)).not.toThrow();
  // The unrelated rename still lands.
  expect(new ConfigService(db).get<string>("g", CONFIG_KEYS.scamSprayAction)).toBe("kick");
});

// The picker can only round-trip 25, so anything above that would be silently dropped
// the first time an admin touched the select.
test("validateSetting refuses a role list longer than the picker can hold", () => {
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!;
  // Built as text: a snowflake is past Number.MAX_SAFE_INTEGER, so arithmetic on one
  // silently collides.
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `1000000000000000${String(i).padStart(2, "0")}`);
  expect(validateSetting(roles, ids(25))).toBe(true);
  expect(validateSetting(roles, ids(26))).toBe(false);
});

test("validateSetting refuses a list that repeats a role", () => {
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!;
  expect(validateSetting(roles, ["123456789012345678", "123456789012345678"])).toBe(false);
});

// Empty means "every category", so coercing a stale value down to empty would quietly
// switch everything on while the panel reported none. Better to refuse it.
test("coerceSetting will not turn a named category into an empty list", () => {
  const cats = REGISTRY_BY_KEY.get(CONFIG_KEYS.ticketCheckCategories)!;
  expect(coerceSetting(cats, "electronics")).toBe("electronics"); // left alone, so it fails validation
  expect(validateSetting(cats, coerceSetting(cats, "electronics"))).toBe(false);
  expect(coerceSetting(cats, "")).toEqual([]); // deliberately empty is still allowed
});

test("coerceSetting normalises a list the same way it normalises a string", () => {
  const cats = REGISTRY_BY_KEY.get(CONFIG_KEYS.ticketCheckCategories)!;
  expect(coerceSetting(cats, ["Reasoning", " english "])).toEqual(["reasoning", "english"]);
  const roles = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!;
  expect(coerceSetting(roles, [" 123456789012345678 "])).toEqual(["123456789012345678"]);
});

// getEffective handed back the registry's own default object, shared by every guild, so
// one caller mutating it would corrupt the default for the whole process.
test("getEffective never hands out the registry's own default object", () => {
  const cfg = new ConfigService(makeTestDb());
  const a = cfg.getEffective<string[]>("g1", CONFIG_KEYS.honeypotExemptRoles);
  const b = cfg.getEffective<string[]>("g2", CONFIG_KEYS.honeypotExemptRoles);
  const registryDefault = REGISTRY_BY_KEY.get(CONFIG_KEYS.honeypotExemptRoles)!.default;
  expect(a).toEqual([]);
  expect(a).not.toBe(registryDefault);
  expect(a).not.toBe(b);
  a.push("mutated");
  expect(cfg.getEffective<string[]>("g3", CONFIG_KEYS.honeypotExemptRoles)).toEqual([]);
});
