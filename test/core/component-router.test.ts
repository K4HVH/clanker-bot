import { expect, test } from "bun:test";
import type { ButtonInteraction } from "discord.js";
import { ComponentRouter } from "../../src/core/component-router";
import type { ComponentHandler } from "../../src/core/module";
import { silentContext } from "../helpers/fakes";

function fakeButton(customId: string) {
  return {
    customId,
    isButton: () => true,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
  } as unknown as ButtonInteraction;
}

test("routes a button to its handler by type+customId", async () => {
  let hit = false;
  const h: ComponentHandler = {
    customId: "verify_start",
    type: "button",
    handle: async () => {
      hit = true;
    },
  };
  const router = new ComponentRouter([h], silentContext());
  await router.handle(fakeButton("verify_start"));
  expect(hit).toBe(true);
});

test("ignores unknown customIds", async () => {
  const router = new ComponentRouter([], silentContext());
  await router.handle(fakeButton("nope")); // no throw
});
