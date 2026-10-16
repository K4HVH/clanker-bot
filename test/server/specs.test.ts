import { expect, test } from "bun:test";
import { validateSpec } from "../../src/server/spec";
import { SPECS } from "../../src/server/specs";

// Every spec shipped in the image validates, so a misspelt key fails here, before it can ship.
for (const [name, spec] of Object.entries(SPECS)) {
  test(`spec "${name}" is valid`, () => {
    expect(validateSpec(spec)).toEqual([]);
    expect(spec.name).toBe(name);
  });
}
