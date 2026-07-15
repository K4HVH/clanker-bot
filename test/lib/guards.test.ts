import { expect, test } from "bun:test";
import { matchBlocklist, parseBlocklist, strongerAction } from "../../src/lib/guards";

test("strongerAction picks the harshest (ban > kick > flag > off)", () => {
  expect(strongerAction("off", "flag")).toBe("flag");
  expect(strongerAction("flag", "kick")).toBe("kick");
  expect(strongerAction("kick", "ban")).toBe("ban");
  expect(strongerAction("ban", "flag")).toBe("ban");
  expect(strongerAction("off", "off")).toBe("off");
});

test("parseBlocklist: case-insensitive substrings, comma/newline separated, blanks skipped", () => {
  const p = parseBlocklist("Nitro,\n  free-gift  ,,\nADMIN");
  expect(p).toHaveLength(3);
  expect(p.some((x) => x.test("get free NITRO here"))).toBe(true);
  expect(p.some((x) => x.test("Free-Gift"))).toBe(true);
  expect(p.some((x) => x.test("Server Admin"))).toBe(true);
  expect(p.some((x) => x.test("totally normal name"))).toBe(false);
});

test("parseBlocklist: /regex/ entries (forced case-insensitive), invalid regex skipped", () => {
  const p = parseBlocklist("/^mod(erator)?$/, /disc[o0]rd\\.gg/, /(unclosed/");
  // The unclosed regex is dropped, leaving two valid patterns.
  expect(p).toHaveLength(2);
  expect(p[0]?.test("MOD")).toBe(true); // forced case-insensitive
  expect(p[0]?.test("moderator")).toBe(true);
  expect(p[0]?.test("moderators")).toBe(false); // anchored
  expect(p[1]?.test("join disc0rd.gg/x")).toBe(true);
});

test("matchBlocklist returns the first matching entry's source, else null; ignores null names", () => {
  const p = parseBlocklist("scam,/nitro/");
  expect(matchBlocklist(p, [null, "free nitro", undefined])).toBe("/nitro/");
  expect(matchBlocklist(p, ["a ScAm link"])).toBe("scam");
  expect(matchBlocklist(p, [null, undefined])).toBeNull();
  expect(matchBlocklist(p, ["clean name"])).toBeNull();
  expect(matchBlocklist([], ["anything"])).toBeNull();
});
