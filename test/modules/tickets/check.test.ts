import { expect, test } from "bun:test";
import { CONFIG_KEYS } from "../../../src/lib/config";
import { readPolicy } from "../../../src/modules/tickets/check";
import { silentContext } from "../../helpers/fakes";

test("readPolicy comes back with the registry defaults", () => {
  const ctx = silentContext();
  expect(readPolicy(ctx, "g")).toEqual({
    enabled: false,
    categories: ["reasoning"],
    questions: 3,
    required: 3,
    seconds: 180,
    passDays: 30,
    cooldownMinutes: 30,
    exemptStaff: true,
    exemptRoles: [],
  });
});

// Two independent knobs can be set to contradict each other, and "must get 5 of 3 right"
// is a gate nobody can pass. Clamping beats rejecting: the guild still gets a check.
test("readPolicy clamps the pass mark to the number of questions asked", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.ticketCheckQuestions, 2);
  ctx.config.set("g", CONFIG_KEYS.ticketCheckRequired, 5);
  expect(readPolicy(ctx, "g").required).toBe(2);
});

test("readPolicy keeps only real role IDs from the exempt list", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.ticketCheckExemptRoles, "123456789012345678, nope\n987654321098765432");
  expect(readPolicy(ctx, "g").exemptRoles).toEqual(["123456789012345678", "987654321098765432"]);
});

