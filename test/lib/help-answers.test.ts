import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatAnswers, rankAnswers, type SiteIndex } from "../../src/lib/help-answers";

const index = JSON.parse(readFileSync(`${import.meta.dir}/fixture-help-index.json`, "utf8")) as SiteIndex;
const top = (q: string) => rankAnswers(index, q)[0]?.url.split("/").pop();

test.each([
  ["my pc keeps blue screening when the makcu is plugged in", "bsod"],
  ["BSOD every time I connect the box", "bsod"],
  ["the dashboard can't find my box", "not-found"],
  ["my logitech superlight feels laggy, stuck at 125hz", "logitech"],
  ["can I use a mouse and keyboard at the same time?", "mouse-and-keyboard"],
  ["does medius support a ps5 controller", "controller"],
  ["how do I go back to the original makcu firmware", "stock-firmware"],
  ["my cheat doesn't work with medius", "software"],
  ["the website won't connect in firefox", "browsers"],
])("%s -> %s", (question, id) => {
  expect(top(question)).toBe(id);
});

test("nothing is offered for a question the Help page doesn't cover", () => {
  expect(rankAnswers(index, "anyone selling a box in europe?")).toEqual([]);
  expect(rankAnswers(index, "hello")).toEqual([]);
});

test("answers are item links, the first unfurled and the rest not", () => {
  const answers = rankAnswers(index, "blue screen after installing the driver");
  expect(answers[0]).toEqual({ title: "My PC blue-screens", url: "https://medius.k4tech.net/guide/help/bsod" });
  expect(formatAnswers(answers.slice(0, 2))).toBe(
    ["These Help answers may cover it:", `- ${answers[0]!.title}: ${answers[0]!.url}`, `- ${answers[1]!.title}: <${answers[1]!.url}>`].join("\n"),
  );
});
