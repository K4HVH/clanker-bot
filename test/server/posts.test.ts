import { expect, test } from "bun:test";
import { splitPost } from "../../src/server/posts";

test("a short post is one chunk", () => {
  expect(splitPost("## Rules\n\n1. One.\n")).toEqual(["## Rules\n\n1. One."]);
});

test("sections pack into chunks of at most 2000 characters", () => {
  const section = (n: number) => `## Part ${n}\n\n${"word ".repeat(290).trim()}\n`;
  const text = [1, 2, 3].map(section).join("\n");
  const chunks = splitPost(text);
  expect(chunks.length).toBe(3);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  expect(chunks.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
});

test("a section over the limit splits at a blank line", () => {
  const para = "x".repeat(900);
  const text = `## Big\n\n${para}\n\n${para}\n\n${para}\n`;
  const chunks = splitPost(text);
  expect(chunks.length).toBe(2);
  expect(chunks[0]).toBe(`## Big\n\n${para}\n\n${para}`);
  expect(chunks[1]).toBe(para);
});
