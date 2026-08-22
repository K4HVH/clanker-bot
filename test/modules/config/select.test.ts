import { expect, test } from "bun:test";
import type { AnySelectMenuInteraction } from "discord.js";
import { ComponentRouter } from "../../../src/core/component-router";
import { CONFIG_KEYS } from "../../../src/lib/config";
import { configModule } from "../../../src/modules/config";
import { silentContext } from "../../helpers/fakes";

const GUILD_ID = "g";

async function choose(
  ctx: ReturnType<typeof silentContext>,
  customId: string,
  values: string[],
): Promise<void> {
  const interaction = {
    customId,
    values,
    guildId: GUILD_ID,
    replied: false,
    deferred: false,
    memberPermissions: { has: () => true },
    isButton: () => false,
    isModalSubmit: () => false,
    update: async () => {},
    reply: async () => {},
  };
  const router = new ComponentRouter(configModule.components ?? [], ctx);
  await router.handle(interaction as unknown as AnySelectMenuInteraction);
}

test("picking several roles stores all of them, not just the first", async () => {
  const ctx = silentContext();
  await choose(ctx, `cfg:roles:${CONFIG_KEYS.ticketCheckExemptRoles}`, [
    "123456789012345678",
    "987654321098765432",
  ]);
  expect(ctx.config.get<string[]>(GUILD_ID, CONFIG_KEYS.ticketCheckExemptRoles)).toEqual([
    "123456789012345678",
    "987654321098765432",
  ]);
});

// Clearing the picker has to mean "nobody is exempt", which is a different thing from
// "never configured", and it must not silently fall back to the default.
test("clearing the role picker stores an empty list", async () => {
  const ctx = silentContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckExemptRoles, ["123456789012345678"]);
  await choose(ctx, `cfg:roles:${CONFIG_KEYS.ticketCheckExemptRoles}`, []);
  expect(ctx.config.get<string[]>(GUILD_ID, CONFIG_KEYS.ticketCheckExemptRoles)).toEqual([]);
});

test("a multi-choice pick stores the list, and junk is refused outright", async () => {
  const ctx = silentContext();
  await choose(ctx, `cfg:multi:${CONFIG_KEYS.ticketCheckCategories}`, ["reasoning"]);
  expect(ctx.config.get<string[]>(GUILD_ID, CONFIG_KEYS.ticketCheckCategories)).toEqual(["reasoning"]);
  await choose(ctx, `cfg:multi:${CONFIG_KEYS.ticketCheckCategories}`, ["not-a-category"]);
  expect(ctx.config.get<string[]>(GUILD_ID, CONFIG_KEYS.ticketCheckCategories)).toEqual(["reasoning"]);
});

test("single-value pickers still store one value", async () => {
  const ctx = silentContext();
  await choose(ctx, `cfg:role:${CONFIG_KEYS.ticketStaffRoleId}`, ["123456789012345678"]);
  expect(ctx.config.get<string>(GUILD_ID, CONFIG_KEYS.ticketStaffRoleId)).toBe("123456789012345678");
  await choose(ctx, `cfg:role:${CONFIG_KEYS.ticketStaffRoleId}`, []);
  expect(ctx.config.get<string>(GUILD_ID, CONFIG_KEYS.ticketStaffRoleId)).toBeUndefined();
});
