import { expect, test } from "bun:test";
import { CATEGORIES, CONFIG_KEYS } from "../../../src/lib/config";
import { buildPanel } from "../../../src/modules/config/panel";
import { silentContext } from "../../helpers/fakes";

// Recursively count Discord components (nodes with a numeric `type`), walking
// nested `components` arrays and Section `accessory` buttons. Select options do
// not count. Discord caps a message at 40 components and 10 top-level.
// biome-ignore lint: test walks untyped API JSON
function count(node: any): number {
  let n = typeof node?.type === "number" ? 1 : 0;
  if (Array.isArray(node?.components)) for (const c of node.components) n += count(c);
  if (node?.accessory) n += count(node.accessory);
  return n;
}

test("every category panel fits Discord's component budget", () => {
  const ctx = silentContext();
  for (const cat of CATEGORIES) {
    const top = buildPanel(ctx, "g", cat.id);
    expect(top.length).toBeLessThanOrEqual(10);
    const total = top.reduce((sum, b) => sum + count(b.toJSON()), 0);
    expect(total).toBeLessThanOrEqual(40);
    expect(total).toBeGreaterThan(3);
  }
});

test("panel reflects current values", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.dmOnAction, true);
  const json = JSON.stringify(buildPanel(ctx, "g", "moderation").map((b) => b.toJSON()));
  expect(json).toContain("cfg:toggle:dm_on_action");
  // the toggle button label reflects the "on" state
  expect(json).toContain('"label":"On"');
});

test("throws on an unknown category (guards against bad state)", () => {
  const ctx = silentContext();
  expect(() => buildPanel(ctx, "g", "does-not-exist")).toThrow();
});
