import { expect, test } from "bun:test";
import { SPECS } from "../../src/server/specs";

// Rule 2 is enforced by Discord's AutoMod, which runs Rust's regex crate. These samples are written
// for the test, never taken from members' messages.

const rule = SPECS.medius!.automod.find((r) => r.key === "rule-2")!;

// Discord keyword semantics: "*x*" anywhere, "x*" word start, "*x" word end, "x" whole word.
function keywordHit(text: string, keyword: string): boolean {
  const lower = text.toLowerCase();
  const core = keyword.replace(/^\*|\*$/g, "").toLowerCase();
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = keyword.startsWith("*") ? "" : "(?<![\\p{L}\\p{N}])";
  const end = keyword.endsWith("*") ? "" : "(?![\\p{L}\\p{N}])";
  return new RegExp(`${start}${escaped}${end}`, "u").test(lower);
}

const regexes = (rule.regex ?? []).map((r) => new RegExp(r.replace(/^\(\?i\)/, ""), "i"));
const blocked = (text: string) => regexes.some((r) => r.test(text)) || (rule.keywords ?? []).some((k) => keywordHit(text, k));

const MATCH = [
  "selling aimbot 15$ dm me",
  "WTS spoofer + loader, $20",
  "dm for config, cheap",
  "triggerbot for sale",
  "aimbot price 10 usd",
  "aimbot $15 lifetime",
  "15$ aimbot lifetime",
  "dm me for the loader",
  "check unknowncheats.me/forum/valorant/123",
  "https://www.mpgh.net/forum/",
  "captaindma.com/product/ysc8k",
];

const PASS = [
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

for (const text of MATCH) test(`blocks: ${text}`, () => expect(blocked(text)).toBe(true));
for (const text of PASS) test(`passes: ${text}`, () => expect(blocked(text)).toBe(false));

test("the patterns use only syntax Rust and JavaScript read alike", () => {
  for (const r of rule.regex ?? []) {
    expect(r).not.toMatch(/\(\?[=!<]/); // lookaround
    expect(r).not.toMatch(/\\[1-9]/); // backreferences
    expect(r.slice(4)).not.toContain("(?i)"); // the flag only leads
    expect(r.length).toBeLessThanOrEqual(260);
  }
});
