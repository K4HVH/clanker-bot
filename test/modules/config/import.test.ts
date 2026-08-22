import { expect, test } from "bun:test";
import { CONFIG_KEYS } from "../../../src/lib/config";
import { applyImport } from "../../../src/modules/config";
import { silentContext } from "../../helpers/fakes";

test("import applies known settings and counts the rest as skipped", () => {
  const ctx = silentContext();
  const result = applyImport(ctx, "g", {
    [CONFIG_KEYS.dmOnAction]: true,
    [CONFIG_KEYS.automodFloodMessages]: 9,
    not_a_setting: "whatever",
    [CONFIG_KEYS.automodFloodMessages.replace("messages", "seconds")]: 999, // out of bounds
  });
  expect(result.applied).toBe(2);
  expect(result.skipped).toBe(2);
  expect(ctx.config.get<boolean>("g", CONFIG_KEYS.dmOnAction)).toBe(true);
});

// Restoring a backup taken before those settings became pickers used to drop them
// silently: validation rejected the old string shape and the reply said only "skipped".
// For the honeypot that means losing the roles it must never action.
test("import upgrades an older export's typed-out lists instead of dropping them", () => {
  const ctx = silentContext();
  const result = applyImport(ctx, "g", {
    [CONFIG_KEYS.honeypotExemptRoles]: "123456789012345678, 987654321098765432",
    [CONFIG_KEYS.ticketCheckCategories]: "reasoning",
  });
  expect(result.skipped).toBe(0);
  expect(ctx.config.get<string[]>("g", CONFIG_KEYS.honeypotExemptRoles)).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
  expect(ctx.config.get<string[]>("g", CONFIG_KEYS.ticketCheckCategories)).toEqual(["reasoning"]);
});

test("import still refuses junk in a list setting", () => {
  const ctx = silentContext();
  const result = applyImport(ctx, "g", { [CONFIG_KEYS.honeypotExemptRoles]: ["not-an-id"] });
  expect(result.applied).toBe(0);
  expect(result.skipped).toBe(1);
});
