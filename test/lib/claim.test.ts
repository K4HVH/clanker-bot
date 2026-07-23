import { expect, test } from "bun:test";
import { Claims } from "../../src/lib/claim";

test("first claim wins, repeats within the TTL lose", () => {
  const c = new Claims(1000);
  expect(c.claim("k", 0)).toBe(true);
  expect(c.claim("k", 500)).toBe(false); // within TTL
  expect(c.claim("k", 1001)).toBe(true); // TTL elapsed
});

test("different keys are independent", () => {
  const c = new Claims(1000);
  expect(c.claim("a", 0)).toBe(true);
  expect(c.claim("b", 0)).toBe(true);
});
