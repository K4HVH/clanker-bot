import { expect, test } from "bun:test";
import type { EmbedBuilder } from "discord.js";
import { run } from "../../src/db/index";
import { modules } from "../../src/modules/index";
import { runForget } from "../../src/modules/moderation/forget";
import { closeTicketQuietly, openTicketChannels } from "../../src/modules/tickets/index";
import { silentContext } from "../helpers/fakes";

test("every module holding a member in memory can forget them", () => {
  for (const name of ["automod", "verification", "tickets", "memes", "logging"]) {
    expect(typeof modules.find((m) => m.name === name)?.forget).toBe("function");
  }
});

test("a quiet close deletes the ticket channel and posts nothing", async () => {
  const deleted: string[] = [];
  openTicketChannels.add("c1");
  await closeTicketQuietly({ id: "c1", delete: async (reason?: string) => void deleted.push(reason ?? "") });
  expect(openTicketChannels.has("c1")).toBe(false);
  expect(deleted).toEqual(["Closed at the member's request"]);
});

function setup(channelId: string, target = "u1") {
  const ctx = silentContext();
  run(ctx.db, "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at) VALUES ('g', 1, 'c1', 'u1', 's', 'open', 1)");
  run(ctx.db, "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at) VALUES ('g', 2, 'c2', 'u1', 's', 'open', 1)");
  run(ctx.db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('g', 1, 'u1', 'm', 'warn', 'r', 1)");
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const closed: string[] = [];
  const logged: EmbedBuilder[] = [];
  const forgotten: string[] = [];
  const interaction = {
    guild: { id: "g" },
    client: { user: { id: "bot" } },
    user: { id: "mod", username: "moddy" },
    channelId,
    channel: { id: channelId, delete: async () => {} },
    options: { getUser: () => ({ id: target }) },
    reply: async (o: unknown) => void replies.push(o),
    deferReply: async () => {},
    editReply: async (o: unknown) => void edits.push(o),
  };
  const deps = {
    modules: [{ name: "x", forget: (_c: unknown, g: string, u: string) => void forgotten.push(`${g}:${u}`) }],
    posts: async () => ({ logPosts: 4, dms: 1, failed: 0, unreachable: ["DMs"] }),
    channel: async (id: string) => ({ id, delete: async () => {} }),
    close: async (c: { id: string }) => void closed.push(c.id),
    log: async (_c: unknown, _g: unknown, e: EmbedBuilder) => void logged.push(e),
  };
  return { ctx, interaction, deps, edits, replies, closed, logged, forgotten };
}

test("forget run in the member's ticket deletes, reports, logs who ran it, then closes their tickets", async () => {
  const s = setup("c1");
  await runForget(s.interaction as never, s.ctx, s.deps as never);
  expect(s.forgotten).toEqual(["g:u1"]);
  expect(s.ctx.db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  expect(s.ctx.db.query("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 0 });
  const summary = "1 case, 2 tickets, 0 check results, 0 captcha challenges, 0 scheduled actions, 4 log posts, 1 DM";
  expect(s.edits).toEqual([{ content: [`Deleted: ${summary}.`, "Not reached: DMs.", "Their 2 open tickets close now, this one last."].join("\n") }]);
  const log = s.logged[0]!.toJSON();
  expect(log.title).toBe("Deleted a member's data at their request.");
  expect(log.fields).toEqual([
    { name: "By", value: "[**moddy**](https://discord.com/users/mod) (mod)" },
    { name: "Deleted", value: summary },
    { name: "Not reached", value: "DMs" },
  ]);
  expect(JSON.stringify(log)).not.toContain("u1");
  expect(s.closed).toEqual(["c2", "c1"]);
});

test("forget run elsewhere still closes their open tickets", async () => {
  const s = setup("c9");
  await runForget(s.interaction as never, s.ctx, s.deps as never);
  expect(s.closed).toEqual(["c1", "c2"]);
  expect(JSON.stringify(s.edits)).toContain("Their 2 open tickets close now.");
});

test("the bot itself can't be forgotten", async () => {
  const s = setup("c9", "bot");
  await runForget(s.interaction as never, s.ctx, s.deps as never);
  expect(s.replies).toEqual([{ content: "That's the bot: there's no member data to delete.", flags: 64 }]);
  expect(s.ctx.db.query("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 1 });
});

test("a reply that can't be sent doesn't stop the log or the closing", async () => {
  const s = setup("c1");
  s.interaction.editReply = async () => {
    throw new Error("Invalid Webhook Token");
  };
  await runForget(s.interaction as never, s.ctx, s.deps as never);
  expect(s.logged).toHaveLength(1);
  expect(s.closed).toEqual(["c2", "c1"]);
});
