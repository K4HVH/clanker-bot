import { expect, test } from "bun:test";
import { applyTemplate, detectMemeAction, extractDuration, replyPool } from "../../src/lib/meme-command";

// detectMemeAction takes the text AFTER the bot mention and matches only the FIRST word.
test("detectMemeAction: recognizes each verb as the first word", () => {
  expect(detectMemeAction("ban that guy @2")).toBe("ban");
  expect(detectMemeAction("kick @2")).toBe("kick");
  expect(detectMemeAction("mute @2 for 10m")).toBe("timeout");
  expect(detectMemeAction("timeout @2")).toBe("timeout");
  expect(detectMemeAction("warn @2")).toBe("warn");
});

test("detectMemeAction: reversals map to their base type", () => {
  expect(detectMemeAction("unban 123")).toBe("unban");
  expect(detectMemeAction("unmute @2")).toBe("untimeout");
  expect(detectMemeAction("untimeout @2")).toBe("untimeout");
});

test("detectMemeAction: no leading verb → null (bare mention stays quiet)", () => {
  expect(detectMemeAction("hello there")).toBeNull();
  expect(detectMemeAction("what's up")).toBeNull();
  expect(detectMemeAction("")).toBeNull();
});

test("detectMemeAction: only the FIRST word counts: negations and mid-sentence verbs don't fire", () => {
  expect(detectMemeAction("don't ban him")).toBeNull(); // first word "dont"
  expect(detectMemeAction("do not kick anyone")).toBeNull(); // first word "do"
  expect(detectMemeAction("warn @2, next time it's a ban")).toBe("warn"); // "warn" wins, not "ban"
  expect(detectMemeAction("please ban @2")).toBeNull(); // "please" first: not a command
});

test("detectMemeAction: leading punctuation is tolerated, substrings aren't", () => {
  expect(detectMemeAction("ban! @2")).toBe("ban");
  expect(detectMemeAction("abandon the ship")).toBeNull(); // 'ban' inside 'abandon'
  expect(detectMemeAction("kickstart the project")).toBeNull(); // 'kick' inside 'kickstart'
});

test("extractDuration: pulls a normalized token (compact or long form) or null", () => {
  expect(extractDuration("mute @2 for 10m")).toBe("10m");
  expect(extractDuration("mute @2 2 h")).toBe("2h");
  expect(extractDuration("mute @2 for 10 minutes")).toBe("10m");
  expect(extractDuration("mute @2 3 days")).toBe("3d");
  expect(extractDuration("mute @2")).toBeNull();
  expect(extractDuration("ban <@1526727441442406610>")).toBeNull(); // a snowflake isn't a duration
});

test("replyPool: configured lines override, blank falls back", () => {
  expect(replyPool("a\n  b  \n\nc", ["x"])).toEqual(["a", "b", "c"]);
  expect(replyPool("", ["x", "y"])).toEqual(["x", "y"]);
  expect(replyPool(undefined, ["x"])).toEqual(["x"]);
});

test("applyTemplate: substitutes known vars, leaves unknown visible", () => {
  expect(applyTemplate("bye {target}, love {mod}", { target: "<@2>", mod: "<@1>" })).toBe("bye <@2>, love <@1>");
  expect(applyTemplate("hi {nope}", {})).toBe("hi {nope}");
});
