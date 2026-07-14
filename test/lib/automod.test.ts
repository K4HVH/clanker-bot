import { expect, test } from "bun:test";
import { type AutomodConfig, checkContentRules } from "../../src/lib/automod";

const on: AutomodConfig = { spam: true, invites: true, links: true, mentionLimit: 5 };

test("flags invite links when enabled", () => {
  expect(checkContentRules("join discord.gg/abc123", 0, on)).toBe("invite link");
});

test("flags external links and mention spam", () => {
  expect(checkContentRules("see https://evil.example", 0, on)).toBe("external link");
  expect(checkContentRules("hi", 6, on)).toBe("mention spam");
});

test("respects disabled rules", () => {
  const off: AutomodConfig = { spam: false, invites: false, links: false, mentionLimit: 5 };
  expect(checkContentRules("discord.gg/abc https://x.y", 99, off)).toBeNull();
});
