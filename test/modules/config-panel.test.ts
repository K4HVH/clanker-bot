import { expect, test } from "bun:test";
import { CATEGORIES, ConfigService } from "../../src/lib/config";
import { buildPanel } from "../../src/modules/config/panel";
import { makeTestDb } from "../helpers/db";

// Discord Components V2 caps a message at 40 total components and 4000 characters of text.
// Descriptions are folded into existing text blocks (no extra component) precisely so a full
// category stays under the component cap, guard both so a new setting can't silently break
// a category's panel (it just fails to send at runtime otherwise).
function counts(json: unknown): { components: number; chars: number } {
  let components = 0;
  let chars = 0;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const x of o) walk(x);
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (k === "type") components++;
        else if ((k === "content" || k === "label" || k === "placeholder") && typeof v === "string") chars += v.length;
        else walk(v);
      }
    }
  };
  walk(json);
  return { components, chars };
}

test("every category panel stays within Discord's V2 component and character limits", () => {
  const config = new ConfigService(makeTestDb());
  const ctx = { config } as unknown as Parameters<typeof buildPanel>[0];
  for (const c of CATEGORIES) {
    const json = buildPanel(ctx, "g", c.id).map((p) => (p as { toJSON(): unknown }).toJSON());
    const { components, chars } = counts(json);
    expect(components).toBeLessThanOrEqual(40);
    expect(chars).toBeLessThanOrEqual(4000);
  }
});
