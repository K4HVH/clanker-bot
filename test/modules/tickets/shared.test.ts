import { expect, test } from "bun:test";
import { countWords, subjectDenial, subjectModal } from "../../../src/modules/tickets/shared";

test("countWords counts words, not whitespace or punctuation", () => {
  expect(countWords("it broke")).toBe(2);
  expect(countWords("  it   broke  ")).toBe(2);
  expect(countWords("My board reboots whenever the motor starts, but it runs fine on USB.")).toBe(13);
  expect(countWords("")).toBe(0);
  expect(countWords("   ")).toBe(0);
  // Punctuation and emoji on their own are not an attempt at a description.
  expect(countWords("??? !!! ...")).toBe(0);
  expect(countWords("😭😭😭")).toBe(0);
  expect(countWords("help 😭")).toBe(1);
  expect(countWords("esp32-s3 won't boot")).toBe(3);
});

test("the subject modal asks for a description when a minimum applies", () => {
  const required = subjectModal(false, 10).toJSON();
  // biome-ignore lint: untyped Discord API JSON
  const input = (required.components[0] as any).components[0];
  expect(input.required).toBe(true);
  expect(input.min_length).toBeGreaterThan(0);
  expect(input.min_length).toBeLessThanOrEqual(input.max_length);

  const optional = subjectModal(false, 0).toJSON();
  // biome-ignore lint: untyped Discord API JSON
  const loose = (optional.components[0] as any).components[0];
  expect(loose.required).toBe(false);
  expect(loose.min_length ?? 0).toBe(0);
});

test("subjectDenial refuses a description that is too short, and hands the text back", () => {
  expect(subjectDenial("My board reboots whenever the motor starts, but runs fine on USB", 10)).toBeNull();
  expect(subjectDenial("anything at all", 0)).toBeNull(); // the rule is off
  const denial = subjectDenial("it broke", 10);
  expect(denial).toContain("10 words");
  // Losing what they typed is the fastest way to make someone give up entirely.
  expect(denial).toContain("it broke");
});
