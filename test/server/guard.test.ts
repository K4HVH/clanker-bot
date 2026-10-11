import { expect, test } from "bun:test";
import { assertNotProduction } from "../../src/server/guard";

test("the local command refuses the production server", () => {
  expect(() => assertNotProduction("g1", { DISCORD_GUILD_ID: "g1" })).toThrow(
    "Refusing to apply to the production server: use /server there.",
  );
  expect(() => assertNotProduction("g2", { DISCORD_GUILD_ID: "g1" })).not.toThrow();
});
