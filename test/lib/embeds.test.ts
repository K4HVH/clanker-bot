import { expect, test } from "bun:test";
import { pack, packGroups } from "../../src/lib/embeds";

test("a message never carries two embeds with one link: Discord would show them as one card", () => {
  const page = "https://example.com/list";
  const [message] = pack([
    { title: "Unsupported", url: page, description: "a" },
    { title: "Partial", url: page, description: "b" },
    { title: "Other", url: "https://example.com/other", description: "c" },
  ]);
  expect(message!.map((e): string | null => e.url ?? null)).toEqual([page, null, "https://example.com/other"]);
  expect(message!.map((e) => e.title)).toEqual(["Unsupported", "Partial", "Other"]);
});

test("a link dropped in one message is kept by the first embed of the next", () => {
  const page = "https://example.com/list";
  const long = "x".repeat(4000);
  const messages = packGroups([
    { group: "a", title: "A", url: page, description: long },
    { group: "b", title: "B", url: page, description: "short" },
    { group: "b", title: "B", url: page, description: long },
  ]);
  expect(messages.map((m) => m.map((e): string | null => e.url ?? null))).toEqual([[page, null], [page]]);
});
