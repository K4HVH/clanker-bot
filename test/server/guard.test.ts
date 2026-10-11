import { expect, test } from "bun:test";
import { assertNotProduction } from "../../src/server/guard";

test("the local command refuses the production server", () => {
  expect(() => assertNotProduction("g1", { DISCORD_GUILD_ID: "g1" })).toThrow(
    "Refusing to apply to the production server: use /server there.",
  );
  expect(() => assertNotProduction("g2", { DISCORD_GUILD_ID: "g1" })).not.toThrow();
});

test("without the production id set, the local command applies nowhere", () => {
  expect(() => assertNotProduction("g2", {})).toThrow("DISCORD_GUILD_ID is not set: run from the checkout, where .env names the production server.");
});
