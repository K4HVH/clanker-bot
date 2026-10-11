import { expect, test } from "bun:test";
import { ruleMatches } from "../../src/server/automod-match";
import { SPECS } from "../../src/server/specs";

// Rule 2 is enforced by two Discord AutoMod rules, which run Rust's regex crate: links to cheat
// forums and shops are blocked; offer-shaped messages alert staff, since talk about cheats stays
// allowed and no pattern tells an offer from talk. These samples are written for the test, never
// taken from members' messages.

const rule = (key: string) => SPECS.medius!.automod.find((r) => r.key === key)!;
const links = rule("rule-2-links");
const offers = rule("rule-2-offers");

test("links are blocked and offers only alert", () => {
  expect(links.block).toBeDefined();
  expect(links.alert).toBe("logs");
  expect(offers.block).toBeUndefined();
  expect(offers.alert).toBe("logs");
});

const BLOCKED = [
  "check unknowncheats.me/forum/valorant/123",
  "https://www.mpgh.net/forum/",
  "captaindma.com/product/ysc8k",
  "https://verse-solutions.com/downtime",
];

const ALERTED = [
  "selling aimbot 15$ dm me",
  "WTS spoofer + loader, $20",
  "dm for config, cheap",
  "triggerbot for sale",
  "aimbot price 10 usd",
  "aimbot $15 lifetime",
  "15$ aimbot lifetime",
  "dm me for the loader",
  "selling cheats is wild", // talk: alerted for staff to judge, never blocked
];

const IGNORED = [
  "my cheat doesn't work with medius",
  "colorbot vs aimbot, which is smoother?",
  "anyone got the discord.gg/abc invite",
  "selling my makcu box, 40 usd",
  "what config do you run in valorant?",
  "does medius work with my aimbot",
  "anyone selling ESP boards?",
  "is the esp32-s3 the same chip?",
  "the price of a makcu went up",
];

for (const text of BLOCKED) test(`blocks: ${text}`, () => expect(ruleMatches(links, text)).toBe(true));
for (const text of ALERTED) {
  test(`alerts, doesn't block: ${text}`, () => {
    expect(ruleMatches(offers, text)).toBe(true);
    expect(ruleMatches(links, text)).toBe(false);
  });
}
for (const text of IGNORED) {
  test(`ignores: ${text}`, () => {
    expect(ruleMatches(links, text)).toBe(false);
    expect(ruleMatches(offers, text)).toBe(false);
  });
}

test("the patterns use only syntax Rust and JavaScript read alike", () => {
  for (const r of [...(links.regex ?? []), ...(offers.regex ?? [])]) {
    expect(r).not.toMatch(/\(\?[=!<]/); // lookaround
    expect(r).not.toMatch(/\\[1-9]/); // backreferences
    expect(r.slice(4)).not.toContain("(?i)"); // the flag only leads
    expect(r.length).toBeLessThanOrEqual(260);
  }
});
