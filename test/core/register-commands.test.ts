import { expect, test } from "bun:test";
import { collectCommandData } from "../../src/core/register-commands";
import { modules } from "../../src/modules";

test("collects one JSON command payload per registered command", () => {
  const data = collectCommandData(modules);
  expect(data.length).toBeGreaterThanOrEqual(1);
  const names = data.map((d) => (d as { name: string }).name);
  expect(names).toContain("config");
});
