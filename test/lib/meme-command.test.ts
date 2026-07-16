import { expect, test } from "bun:test";
import { applyTemplate, detectMemeAction, extractDuration, replyPool } from "../../src/lib/meme-command";

test("detectMemeAction: recognizes each verb", () => {
  expect(detectMemeAction("<@1> ban that guy @2")).toBe("ban");
  expect(detectMemeAction("<@1> kick @2")).toBe("kick");
  expect(detectMemeAction("<@1> mute @2 for 10m")).toBe("timeout");
  expect(detectMemeAction("<@1> timeout @2")).toBe("timeout");
  expect(detectMemeAction("<@1> warn @2")).toBe("warn");
});

test("detectMemeAction: reversals win over their base verb", () => {
  expect(detectMemeAction("<@1> unban 123")).toBe("unban");
  expect(detectMemeAction("<@1> unmute @2")).toBe("untimeout");
  expect(detectMemeAction("<@1> untimeout @2")).toBe("untimeout");
});

test("detectMemeAction: no verb → null (bare mention stays quiet)", () => {
  expect(detectMemeAction("<@1> hello there")).toBeNull();
  expect(detectMemeAction("<@1> what's up")).toBeNull();
});

test("detectMemeAction: word-boundaried (doesn't fire on substrings)", () => {
  expect(detectMemeAction("<@1> abandon the ship")).toBeNull(); // 'ban' inside 'abandon'
  expect(detectMemeAction("<@1> kickstart the project")).toBeNull(); // 'kick' inside 'kickstart'
});

test("extractDuration: pulls a normalized token or null", () => {
  expect(extractDuration("mute @2 for 10m")).toBe("10m");
  expect(extractDuration("mute @2 2 h")).toBe("2h");
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
