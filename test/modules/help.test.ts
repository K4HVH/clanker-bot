import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerPost, markSolved } from "../../src/modules/help/index";
import type { SiteIndex } from "../../src/lib/help-answers";
import { verifiedText } from "../../src/lib/verification-logic";
import { defineServer } from "../../src/server/spec";
import { putState, setSpecName } from "../../src/server/state";
import { silentContext } from "../helpers/fakes";

const spec = defineServer({
  name: "t",
  dir: import.meta.dir,
  guild: {},
  everyone: { permissions: [] },
  roles: [],
  channels: [
    { key: "help", type: "forum", name: "help", forum: { tags: [{ name: "Install" }, { name: "Solved", moderated: true }], solvedTag: "Solved", answers: true } },
    { key: "feedback", type: "forum", name: "feedback", forum: { tags: [{ name: "Idea" }] } },
  ],
  automod: [],
  posts: [],
  bot: {},
});
const specs = { t: spec };
const index = JSON.parse(readFileSync(`${import.meta.dir}/../lib/fixture-help-index.json`, "utf8")) as SiteIndex;

function setup() {
  const ctx = silentContext();
  setSpecName(ctx.db, "g", "t");
  putState(ctx.db, "g", "channel", "help", "forum1");
  putState(ctx.db, "g", "channel", "feedback", "forum2");
  return ctx;
}

function solvedInteraction(userId: string, parentId = "forum1", canManage = false) {
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const thread = {
    id: "t1",
    parentId,
    ownerId: "asker",
    appliedTags: ["tagInstall"],
    isThread: () => true,
    parent: { availableTags: [{ id: "tagInstall", name: "Install" }, { id: "tagSolved", name: "Solved" }] },
    edit: async (o: unknown) => void edits.push(o),
  };
  return {
    replies,
    edits,
    i: {
      guildId: "g",
      user: { id: userId },
      channel: thread,
      memberPermissions: { has: () => canManage },
      reply: async (o: unknown) => void replies.push(o),
    },
  };
}

test("the asker marks their post solved: the tag goes on, then the post closes", async () => {
  const ctx = setup();
  const s = solvedInteraction("asker");
  await markSolved(s.i as never, ctx, specs);
  expect(s.replies).toEqual([{ content: "Marked solved. Post here again to reopen it." }]);
  expect(s.edits).toEqual([{ appliedTags: ["tagInstall", "tagSolved"], archived: true }]);
});

test("someone else can't, unless they can manage posts", async () => {
  const ctx = setup();
  const s = solvedInteraction("someone");
  await markSolved(s.i as never, ctx, specs);
  expect(s.replies).toEqual([{ content: "Only whoever started this post, or staff, can mark it solved.", flags: 64 }]);
  const staff = solvedInteraction("staff", "forum1", true);
  await markSolved(staff.i as never, ctx, specs);
  expect(staff.edits).toHaveLength(1);
});

test("/solved outside a help post says where it works", async () => {
  const ctx = setup();
  const s = solvedInteraction("asker", "forum2");
  await markSolved(s.i as never, ctx, specs);
  expect(s.replies).toEqual([{ content: "/solved works inside a help post.", flags: 64 }]);
});

test("a new help post gets matching Help answers; a post nothing matches gets none", async () => {
  const ctx = setup();
  const sent: string[] = [];
  const thread = (name: string, content: string) => ({
    id: "t2",
    guildId: "g",
    parentId: "forum1",
    name,
    fetchStarterMessage: async () => ({ content }),
    send: async (o: { content: string }) => void sent.push(o.content),
  });
  await answerPost(ctx, thread("BSOD", "my pc blue screens when the box is plugged in") as never, specs, async () => index);
  expect(sent[0]).toContain("https://medius.k4tech.net/guide/help/bsod");
  await answerPost(ctx, thread("hi", "anyone around?") as never, specs, async () => index);
  expect(sent).toHaveLength(1);
});

test("a post in a forum without answers gets none", async () => {
  const ctx = setup();
  const sent: string[] = [];
  const thread = { id: "t3", guildId: "g", parentId: "forum2", name: "BSOD", fetchStarterMessage: async () => ({ content: "blue screen" }), send: async (o: { content: string }) => void sent.push(o.content) };
  await answerPost(ctx, thread as never, specs, async () => index);
  expect(sent).toEqual([]);
});

test("the captcha's success points at the start-here channel when one is set", () => {
  expect(verifiedText()).toBe("✅ You're verified. Welcome!");
  expect(verifiedText("123")).toBe("✅ You're verified. Welcome! Pick what you want to see in <#123>.");
});
