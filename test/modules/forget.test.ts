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

function setup(channelId: string) {
  const ctx = silentContext();
  run(ctx.db, "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at) VALUES ('g', 1, 'c1', 'u1', 's', 'open', 1)");
  run(ctx.db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('g', 1, 'u1', 'm', 'warn', 'r', 1)");
  const edits: unknown[] = [];
  const closed: string[] = [];
  const logged: string[] = [];
  const forgotten: string[] = [];
  const interaction = {
    guild: { id: "g" },
    channelId,
    channel: { id: channelId, delete: async () => void closed.push(channelId) },
    options: { getUser: () => ({ id: "u1" }) },
    deferReply: async () => {},
    editReply: async (o: unknown) => void edits.push(o),
  };
  const deps = {
    modules: [{ name: "x", forget: (_c: unknown, g: string, u: string) => void forgotten.push(`${g}:${u}`) }],
    posts: async () => ({ logPosts: 4, dms: 1, unreachable: ["DMs"] }),
    close: async (c: { id: string }) => void closed.push(c.id),
    log: async (_c: unknown, _g: unknown, e: EmbedBuilder) => void logged.push(e.data.title ?? ""),
  };
  return { ctx, interaction, deps, edits, closed, logged, forgotten };
}

test("forget run in the member's ticket deletes, reports, logs without an id, then closes the ticket", async () => {
  const s = setup("c1");
  await runForget(s.interaction as never, s.ctx, s.deps as never);
  expect(s.forgotten).toEqual(["g:u1"]);
  expect(s.ctx.db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  expect(s.ctx.db.query("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 0 });
  expect(s.edits).toEqual([
    {
      content: [
        "Deleted: 1 case, 1 ticket, 0 check results, 0 captcha challenges, 0 scheduled actions, 4 log posts, 1 DM.",
        "Not reached: DMs.",
        "This ticket closes now.",
      ].join("\n"),
    },
  ]);
  expect(s.logged).toEqual(["Deleted a member's data at their request."]);
  expect(s.closed).toEqual(["c1"]);
});

test("forget run elsewhere closes nothing", async () => {
  const s = setup("c9");
  await runForget(s.interaction as never, s.ctx, s.deps as never);
  expect(s.closed).toEqual([]);
  expect(JSON.stringify(s.edits)).not.toContain("closes now");
});
