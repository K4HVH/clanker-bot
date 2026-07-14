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

test("captchaWidth leaves room for the last glyph at every allowed length (4-8)", () => {
  for (let len = 4; len <= 8; len++) {
    // Last glyph anchors at 26 + (len-1)*34; a 44px bold glyph needs ~34px of
    // advance. Require comfortable headroom beyond the anchor so nothing clips.
    const lastAnchor = 26 + (len - 1) * 34;
    expect(captchaWidth(len) - lastAnchor).toBeGreaterThanOrEqual(50);
  }
});

test("renderCaptcha produces a valid PNG", async () => {
  const png = await renderCaptcha("A7K9Q3");
  expect(png.length).toBeGreaterThan(500);
  expect(png[0]).toBe(0x89);
  expect(png[1]).toBe(0x50); // 'P'
});

test("renderCaptcha handles the maximum configurable length (8) without clipping/throwing", async () => {
  const png = await renderCaptcha(generateCode(8));
  expect(png.length).toBeGreaterThan(500);
  expect(png[0]).toBe(0x89);
});
