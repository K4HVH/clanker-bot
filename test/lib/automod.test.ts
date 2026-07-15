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
const noCtx = { mentionCount: 0, massMention: false };

test("invites: catches multiple hosts, only when enabled", () => {
  const on: ContentRules = { ...base, invites: true };
  expect(checkContent("join discord.gg/abc123", noCtx, on)).toBe("invite link");
  expect(checkContent("https://discord.com/invite/xyz", noCtx, on)).toBe("invite link");
  expect(checkContent("dsc.gg/coolserver", noCtx, on)).toBe("invite link");
  expect(checkContent("discord.gg/abc", noCtx, base)).toBeNull(); // disabled
});

test("mentions: limit (0=off) and @everyone/@here via the ping flag", () => {
  expect(checkContent("hi", { mentionCount: 6, massMention: false }, { ...base, mentionLimit: 5 })).toBe(
    "excessive mentions",
  );
  expect(checkContent("hi", { mentionCount: 6, massMention: false }, { ...base, mentionLimit: 0 })).toBeNull();
  // Uses the real ping flag, not text — "@everyone" in a code block (flag false) is NOT flagged.
  expect(checkContent("real ping", { mentionCount: 0, massMention: true }, { ...base, massMention: true })).toBe(
    "@everyone / @here",
  );
  expect(
    checkContent("`@everyone` in code", { mentionCount: 0, massMention: false }, { ...base, massMention: true }),
  ).toBeNull();
});

test("word blocklist: whole-word (no Scunthorpe) + /regex/", () => {
  const on: ContentRules = { ...base, wordBlocklist: "ass\n/free ?nitro/" };
  expect(checkContent("what an ASS you are", noCtx, on)).toContain("blocked term"); // whole word
  expect(checkContent("this is a class assignment", noCtx, on)).toBeNull(); // NOT "class"/"assignment"
  expect(checkContent("get free nitro now", noCtx, on)).toContain("blocked term");
});

test("links: blocked unless the domain is allowlisted (subdomains, www, trailing dot ok)", () => {
  const on: ContentRules = { ...base, links: true, linkAllowlist: "github.com, docs.espressif.com" };
  expect(checkContent("see https://evil.example/x", noCtx, on)).toBe("external link");
  expect(checkContent("repo https://github.com/a/b", noCtx, on)).toBeNull();
  expect(checkContent("https://api.github.com/x", noCtx, on)).toBeNull(); // subdomain
  expect(checkContent("visit https://github.com.", noCtx, on)).toBeNull(); // trailing dot
});

test("hasUnallowedLink normalizes www + punctuation; caps has a high floor", () => {
  expect(hasUnallowedLink("no links here", "")).toBe(false);
  expect(hasUnallowedLink("https://x.com", "")).toBe(true); // empty allowlist blocks all
  expect(hasUnallowedLink("https://x.com", "x.com")).toBe(false);
  expect(hasUnallowedLink("go to www.github.com now", "github.com")).toBe(false); // www stripped
  expect(hasUnallowedLink("go to www.evil.com now", "github.com")).toBe(true);

  expect(isCapsSpam("THIS IS COMPLETELY UNACCEPTABLE BEHAVIOUR")).toBe(true);
  expect(isCapsSpam("GPIO UART I2C SPI ADC")).toBe(false); // short acronym list — under the floor
  expect(isCapsSpam("normal message")).toBe(false);
});
