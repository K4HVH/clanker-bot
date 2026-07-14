import { expect, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
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
  } as unknown as MessageComponentInteraction;
}

function fakeSelect(customId: string) {
  return {
    customId,
    isButton: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
  } as unknown as MessageComponentInteraction;
}

test("routes a button to an exact handler", async () => {
  let hit = "";
  const h: ComponentHandler = {
    customId: "verify_start",
    type: "button",
    handle: async () => {
      hit = "exact";
    },
  };
  const router = new ComponentRouter([h], silentContext());
  await router.handle(fakeButton("verify_start"));
  expect(hit).toBe("exact");
});

test("prefix handler matches customId and customId:...", async () => {
  const seen: string[] = [];
  const h: ComponentHandler = {
    customId: "cfg",
    type: "button",
    match: "prefix",
    handle: async (i) => {
      seen.push(i.customId);
    },
  };
  const router = new ComponentRouter([h], silentContext());
  await router.handle(fakeButton("cfg"));
  await router.handle(fakeButton("cfg:toggle:automod_spam"));
  await router.handle(fakeButton("cfgX")); // no ':' boundary -> not matched
  expect(seen).toEqual(["cfg", "cfg:toggle:automod_spam"]);
});

test("dispatches select-menu interactions by type", async () => {
  let hit = false;
  const h: ComponentHandler = {
    customId: "cfg",
    type: "select",
    match: "prefix",
    handle: async () => {
      hit = true;
    },
  };
  const router = new ComponentRouter([h], silentContext());
  await router.handle(fakeSelect("cfg:cat"));
  expect(hit).toBe(true);
});

test("a button handler does not catch a select of the same id", async () => {
  let hit = false;
  const h: ComponentHandler = {
    customId: "cfg:cat",
    type: "button",
    handle: async () => {
      hit = true;
    },
  };
  const router = new ComponentRouter([h], silentContext());
  await router.handle(fakeSelect("cfg:cat"));
  expect(hit).toBe(false);
});

test("ignores unknown customIds", async () => {
  const router = new ComponentRouter([], silentContext());
  await router.handle(fakeButton("nope"));
});
