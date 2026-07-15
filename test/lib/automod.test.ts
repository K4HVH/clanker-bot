import { expect, test } from "bun:test";
import { checkContent, type ContentRules, hasUnallowedLink, isCapsSpam } from "../../src/lib/automod";

const base: ContentRules = {
  invites: false,
  links: false,
  linkAllowlist: "",
  wordBlocklist: "",
  mentionLimit: 0,
  massMention: false,
  caps: false,
};

test("invites: catches multiple hosts, only when enabled", () => {
  const on: ContentRules = { ...base, invites: true };
  expect(checkContent("join discord.gg/abc123", { mentionCount: 0 }, on)).toBe("invite link");
  expect(checkContent("https://discord.com/invite/xyz", { mentionCount: 0 }, on)).toBe("invite link");
  expect(checkContent("dsc.gg/coolserver", { mentionCount: 0 }, on)).toBe("invite link");
  expect(checkContent("discord.gg/abc", { mentionCount: 0 }, base)).toBeNull(); // disabled
});

test("mentions: limit (0=off) and @everyone/@here", () => {
  expect(checkContent("hi", { mentionCount: 6 }, { ...base, mentionLimit: 5 })).toBe("excessive mentions");
  expect(checkContent("hi", { mentionCount: 6 }, { ...base, mentionLimit: 0 })).toBeNull(); // off
  expect(checkContent("yo @everyone free stuff", { mentionCount: 0 }, { ...base, massMention: true })).toBe(
    "@everyone / @here",
  );
});

test("word blocklist: substring + /regex/, reusing the guards engine", () => {
  const on: ContentRules = { ...base, wordBlocklist: "badword\n/free ?nitro/" };
  expect(checkContent("that is a BADWORD here", { mentionCount: 0 }, on)).toContain("blocked term");
  expect(checkContent("get free nitro now", { mentionCount: 0 }, on)).toContain("blocked term");
  expect(checkContent("totally clean", { mentionCount: 0 }, on)).toBeNull();
});

test("links: blocked unless the domain is allowlisted (subdomains ok)", () => {
  const on: ContentRules = { ...base, links: true, linkAllowlist: "github.com, docs.espressif.com" };
  expect(checkContent("see https://evil.example/x", { mentionCount: 0 }, on)).toBe("external link");
  expect(checkContent("repo https://github.com/a/b", { mentionCount: 0 }, on)).toBeNull(); // allowed
  expect(checkContent("https://api.github.com/x", { mentionCount: 0 }, on)).toBeNull(); // subdomain allowed
});

test("hasUnallowedLink / isCapsSpam units", () => {
  expect(hasUnallowedLink("no links here", "")).toBe(false);
  expect(hasUnallowedLink("https://x.com", "")).toBe(true); // empty allowlist blocks all
  expect(hasUnallowedLink("https://x.com", "x.com")).toBe(false);
  expect(isCapsSpam("THIS IS ALL SHOUTING")).toBe(true);
  expect(isCapsSpam("normal message")).toBe(false);
  expect(isCapsSpam("OK")).toBe(false); // under the length floor
});
