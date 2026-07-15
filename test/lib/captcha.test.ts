import { expect, test } from "bun:test";
import { captchaWidth, generateCode, renderCaptcha } from "../../src/lib/captcha";

test("generateCode returns the requested length from the safe charset", () => {
  const code = generateCode(6);
  expect(code).toHaveLength(6);
  expect(/^[ABCDEFGHJKMNPQRSTUVWXYZ3479]+$/.test(code)).toBe(true);
});

test("generateCode never emits an ambiguous glyph (0O1IL2568)", () => {
  const codes = Array.from({ length: 200 }, () => generateCode(8)).join("");
  expect(/[0O1IL2568]/.test(codes)).toBe(false);
});

test("captchaWidth grows with length (no clipping for longer codes)", () => {
  for (let len = 4; len < 8; len++) {
    expect(captchaWidth(len + 1)).toBeGreaterThan(captchaWidth(len));
  }
});

test("renderCaptcha produces a valid PNG", async () => {
  const png = await renderCaptcha("A7K9Q3");
  expect(png.length).toBeGreaterThan(500);
  expect(png[0]).toBe(0x89);
  expect(png[1]).toBe(0x50); // 'P'
});

test("renderCaptcha renders every length (4-8) and difficulty (1-5) without throwing", async () => {
  for (let len = 4; len <= 8; len++) {
    for (const diff of [1, 2, 3, 4, 5] as const) {
      const png = await renderCaptcha(generateCode(len), diff);
      expect(png.length).toBeGreaterThan(500);
      expect(png[0]).toBe(0x89);
    }
  }
});
