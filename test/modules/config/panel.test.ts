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

// ── pickers, not typing ─────────────────────────────────────────────────────

// biome-ignore lint: walks untyped API JSON
function find(json: any, customId: string): any {
  if (Array.isArray(json)) {
    for (const x of json) {
      const hit = find(x, customId);
      if (hit) return hit;
    }
    return null;
  }
  if (json && typeof json === "object") {
    if (json.custom_id === customId) return json;
    for (const v of Object.values(json)) {
      const hit = find(v, customId);
      if (hit) return hit;
    }
  }
  return null;
}

const panelJson = (ctx: ReturnType<typeof silentContext>, category: string) =>
  buildPanel(ctx, "g", category).map((b) => b.toJSON());

test("an exempt-roles setting is a role picker, not an ID box", () => {
  const ctx = silentContext();
  const json = panelJson(ctx, "ticket-check");
  const select = find(json, `cfg:roles:${CONFIG_KEYS.ticketCheckExemptRoles}`);
  expect(select).not.toBeNull();
  expect(select.max_values).toBeGreaterThan(1);
  expect(select.min_values).toBe(0); // clearing it out has to be possible
  // Nothing left that would pop a modal to type IDs into.
  expect(find(json, `cfg:edit:${CONFIG_KEYS.ticketCheckExemptRoles}`)).toBeNull();
});

test("the role picker opens with the guild's current roles already selected", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.ticketCheckExemptRoles, [
    "123456789012345678",
    "987654321098765432",
  ]);
  const select = find(panelJson(ctx, "ticket-check"), `cfg:roles:${CONFIG_KEYS.ticketCheckExemptRoles}`);
  expect(select.default_values).toEqual([
    { id: "123456789012345678", type: "role" },
    { id: "987654321098765432", type: "role" },
  ]);
});

test("question categories are picked from a list of the ones that exist", () => {
  const ctx = silentContext();
  const select = find(panelJson(ctx, "ticket-check"), `cfg:multi:${CONFIG_KEYS.ticketCheckCategories}`);
  expect(select).not.toBeNull();
  expect(select.options.map((o: { value: string }) => o.value)).toEqual(["reasoning", "english"]);
  expect(select.options.find((o: { value: string }) => o.value === "reasoning").default).toBe(true);
});

test("the honeypot's exempt roles get the same picker", () => {
  const select = find(panelJson(silentContext(), "honeypot"), `cfg:roles:${CONFIG_KEYS.honeypotExemptRoles}`);
  expect(select).not.toBeNull();
});
