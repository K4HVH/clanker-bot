import { expect, test } from "bun:test";
import { messageMatchesPurge, type PurgeableMessage } from "../../src/lib/purge";

const msg = (over: Partial<PurgeableMessage>): PurgeableMessage => ({
  authorId: "u1",
  authorBot: false,
  content: "hello",
  attachmentCount: 0,
  ...over,
});

test("purge match: no criteria matches everything", () => {
  expect(messageMatchesPurge(msg({}), {})).toBe(true);
});

test("purge match: user scopes to one author", () => {
  expect(messageMatchesPurge(msg({ authorId: "kenny" }), { userId: "kenny" })).toBe(true);
  expect(messageMatchesPurge(msg({ authorId: "other" }), { userId: "kenny" })).toBe(false);
});

test("purge match: bots / humans filters", () => {
  expect(messageMatchesPurge(msg({ authorBot: true }), { filter: "bots" })).toBe(true);
  expect(messageMatchesPurge(msg({ authorBot: false }), { filter: "bots" })).toBe(false);
  expect(messageMatchesPurge(msg({ authorBot: false }), { filter: "humans" })).toBe(true);
  expect(messageMatchesPurge(msg({ authorBot: true }), { filter: "humans" })).toBe(false);
});

test("purge match: links filter catches http(s), www., and invites", () => {
  expect(messageMatchesPurge(msg({ content: "see https://x.com" }), { filter: "links" })).toBe(true);
  expect(messageMatchesPurge(msg({ content: "go to www.evil.com" }), { filter: "links" })).toBe(true);
  expect(messageMatchesPurge(msg({ content: "join discord.gg/abc" }), { filter: "links" })).toBe(true);
  expect(messageMatchesPurge(msg({ content: "no link here" }), { filter: "links" })).toBe(false);
});

test("purge match: attachments filter needs at least one", () => {
  expect(messageMatchesPurge(msg({ attachmentCount: 2 }), { filter: "attachments" })).toBe(true);
  expect(messageMatchesPurge(msg({ attachmentCount: 0 }), { filter: "attachments" })).toBe(false);
});

test("purge match: user + filter combine (both must hold)", () => {
  const c = { userId: "kenny", filter: "links" };
  expect(messageMatchesPurge(msg({ authorId: "kenny", content: "http://x" }), c)).toBe(true);
  expect(messageMatchesPurge(msg({ authorId: "kenny", content: "plain" }), c)).toBe(false);
  expect(messageMatchesPurge(msg({ authorId: "other", content: "http://x" }), c)).toBe(false);
});
