import { expect, test } from "bun:test";
import { generateCode, renderCaptcha } from "../../src/lib/captcha";

test("generateCode returns the requested length from the safe charset", () => {
  const code = generateCode(6);
  expect(code).toHaveLength(6);
  expect(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(code)).toBe(true);
});

test("renderCaptcha produces a valid PNG", async () => {
  const png = await renderCaptcha("A7K9Q2");
  expect(png.length).toBeGreaterThan(500);
  expect(png[0]).toBe(0x89);
  expect(png[1]).toBe(0x50); // 'P'
});
