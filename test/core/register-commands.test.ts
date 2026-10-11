import { expect, test } from "bun:test";
import { Routes } from "discord.js";
import { collectCommandData, registerGuildCommands } from "../../src/core/register-commands";
import { modules } from "../../src/modules";

test("collects one JSON command payload per registered command", () => {
  const data = collectCommandData(modules);
  expect(data.length).toBeGreaterThanOrEqual(1);
  const names = data.map((d) => (d as { name: string }).name);
  expect(names).toContain("config");
});

test("registers the command set in the named guild", async () => {
  const calls: { route: string; body: unknown }[] = [];
  const rest = {
    put: async (route: string, opts: { body: unknown }) => void calls.push({ route, body: opts.body }),
  };
  const n = await registerGuildCommands(rest as never, "app", "g2", modules);
  expect(calls).toEqual([
    { route: Routes.applicationGuildCommands("app", "g2"), body: collectCommandData(modules) },
  ]);
  expect(n).toBe(collectCommandData(modules).length);
});
