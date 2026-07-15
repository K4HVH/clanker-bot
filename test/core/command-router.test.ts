import { expect, test } from "bun:test";
import { CommandRouter } from "../../src/core/command-router";
import type { SlashCommand } from "../../src/core/module";
import { fakeInteraction, silentContext } from "../helpers/fakes";

function cmd(name: string, execute: SlashCommand["execute"]): SlashCommand {
  return { data: { name, toJSON: () => ({}) } as SlashCommand["data"], execute };
}

test("dispatches to the matching command", async () => {
  let called = false;
  const router = new CommandRouter(
    [
      cmd("example", async () => {
        called = true;
      }),
    ],
    [],
    silentContext(),
  );
  await router.handle(fakeInteraction("example"));
  expect(called).toBe(true);
});

test("ignores unknown commands without throwing", async () => {
  const router = new CommandRouter([], [], silentContext());
  await router.handle(fakeInteraction("nope"));
  // no throw = pass
});

test("catches command errors and replies ephemerally", async () => {
  const router = new CommandRouter(
    [
      cmd("boom", async () => {
        throw new Error("kaboom");
      }),
    ],
    [],
    silentContext(),
  );
  const interaction = fakeInteraction("boom");
  await router.handle(interaction);
  expect(interaction.replied).toBe(true);
});
