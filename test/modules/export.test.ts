import { expect, test } from "bun:test";
import type { EmbedBuilder } from "discord.js";
import { run } from "../../src/db/index";
import { runExport } from "../../src/modules/moderation/export";
import { silentContext } from "../helpers/fakes";

function setup(channelId: string, target = "u1") {
  const ctx = silentContext();
  run(ctx.db, "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at) VALUES ('g', 1, 'c1', 'u1', 'my data', 'open', 1)");
  run(ctx.db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('g', 1, 'u1', 'm', 'warn', 'r', 1)");
  const deferred: unknown[] = [];
  const edits: { content?: string; files?: { name: string; attachment: Buffer }[] }[] = [];
  const replies: unknown[] = [];
  const logged: EmbedBuilder[] = [];
  const interaction = {
    guild: { id: "g", name: "Medius" },
    client: { user: { id: "bot" } },
    user: { id: "mod", username: "moddy" },
    channelId,
    options: { getUser: () => ({ id: target }) },
    reply: async (o: unknown) => void replies.push(o),
    deferReply: async (o: unknown) => void deferred.push(o ?? {}),
    editReply: async (o: never) => void edits.push(o),
  };
  const deps = {
    posts: async () => ({ posts: [{ channel: "#logs", id: "9", at: "2026-10-01T00:00:00.000Z", text: "Warned u1" }], unreachable: [] }),
    log: async (_c: unknown, _g: unknown, e: EmbedBuilder) => void logged.push(e),
  };
  return { ctx, interaction, deps, deferred, edits, replies, logged };
}

const file = (s: ReturnType<typeof setup>) => {
  const f = s.edits.at(-1)!.files![0]!;
  return { name: f.name, data: JSON.parse(f.attachment.toString("utf8")) };
};

test("export run in the member's ticket posts their copy there, and logs who ran it", async () => {
  const s = setup("c1");
  await runExport(s.interaction as never, s.ctx, s.deps as never);
  expect(s.deferred).toEqual([{}]);
  const { name, data } = file(s);
  expect(name).toBe("data-u1.json");
  expect(data.user).toBe("u1");
  expect(data.cases).toHaveLength(1);
  expect(data.tickets[0].subject).toBe("my data");
  expect(data.logPosts).toEqual([{ channel: "#logs", id: "9", at: "2026-10-01T00:00:00.000Z", text: "Warned u1" }]);
  expect(s.edits.at(-1)!.content).toBe("A copy of everything the bot holds on you: 1 case, 1 ticket, 0 check results, 0 captcha challenges, 0 scheduled actions, 1 log post.");
  expect(JSON.stringify(s.logged[0]!.toJSON())).toContain("Sent a member a copy of their data at their request.");
  expect(JSON.stringify(s.logged[0]!.toJSON())).not.toContain("u1");
});

test("export run anywhere else goes only to whoever ran it", async () => {
  const s = setup("general");
  await runExport(s.interaction as never, s.ctx, s.deps as never);
  expect(s.deferred).toEqual([{ flags: 64 }]);
  expect(s.edits.at(-1)!.content).toBe(
    "A copy of everything the bot holds on <@u1>: 1 case, 1 ticket, 0 check results, 0 captcha challenges, 0 scheduled actions, 1 log post. Only you can see this; run it in their ticket to send it to them.",
  );
  expect(file(s).name).toBe("data-u1.json");
});

test("the bot itself has no copy to give", async () => {
  const s = setup("c1", "bot");
  await runExport(s.interaction as never, s.ctx, s.deps as never);
  expect(JSON.stringify(s.replies[0])).toContain("That's the bot");
  expect(s.edits).toEqual([]);
});
