import { expect, test } from "bun:test";
import { run } from "../../src/db/index";
import { kindOf, type LogChannelApi, type LogMessage, purgeChannel, purgeRows } from "../../src/lib/retention";
import { silentContext } from "../helpers/fakes";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function seed() {
  const ctx = silentContext();
  const db = ctx.db;
  const kase = (n: number, user: string, ageDays: number) =>
    run(db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('g', ?, ?, 'm', 'warn', 'r', ?)", n, user, NOW - ageDays * DAY);
  kase(1, "old", 400);
  kase(2, "new", 10);
  run(db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('other', 1, 'old', 'm', 'warn', 'r', ?)", NOW - 400 * DAY);
  const ticket = (n: number, status: string, closedDays: number | null) =>
    run(db, "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at, closed_at) VALUES ('g', ?, ?, 'u', 's', ?, ?, ?)", n, `c${n}`, status, NOW - 500 * DAY, closedDays === null ? null : NOW - closedDays * DAY);
  ticket(1, "closed", 400);
  ticket(2, "closed", 30);
  ticket(3, "open", null);
  const check = (user: string, passedDays: number | null, failedHours: number | null) =>
    run(db, "INSERT INTO ticket_check_results (guild_id, user_id, passed_at, failed_at, fails) VALUES ('g', ?, ?, ?, 1)", user, passedDays === null ? null : NOW - passedDays * DAY, failedHours === null ? null : NOW - failedHours * 3_600_000);
  check("stale", 40, 48); // pass expired (30 days), failed two days ago: gone
  check("cooling", 40, 1); // failed an hour ago: its cooldown may still run
  check("valid", 10, null); // pass still good
  check("never", null, 30); // never passed, last failure 30 hours ago: gone
  return ctx;
}

test("rows past their retention are deleted, and nothing else", () => {
  const ctx = seed();
  expect(purgeRows(ctx, "g", NOW)).toEqual({ cases: 1, tickets: 1, checks: 2 });
  const left = (sql: string) => ctx.db.query(sql).all();
  expect(left("SELECT user_id FROM cases WHERE guild_id = 'g'")).toEqual([{ user_id: "new" }]);
  expect(left("SELECT COUNT(*) AS n FROM cases WHERE guild_id = 'other'")).toEqual([{ n: 1 }]);
  expect(left("SELECT ticket_number FROM tickets ORDER BY ticket_number")).toEqual([{ ticket_number: 2 }, { ticket_number: 3 }]);
  expect(left("SELECT user_id FROM ticket_check_results ORDER BY user_id")).toEqual([{ user_id: "cooling" }, { user_id: "valid" }]);
});

test("the settings move the cutoffs", () => {
  const ctx = seed();
  ctx.config.set("g", "retention_moderation_days", 5);
  ctx.config.set("g", "retention_tickets_days", 3650);
  expect(purgeRows(ctx, "g", NOW)).toMatchObject({ cases: 2, tickets: 0 });
});

const msg = (id: number, ageDays: number, over: Partial<LogMessage> = {}): LogMessage => ({
  id: String(id),
  authorId: "bot",
  createdAt: NOW - ageDays * DAY,
  title: "Message deleted",
  attachments: [],
  ...over,
});

test("posts are sorted by what they record", () => {
  expect(kindOf(msg(1, 0))).toBe("member");
  expect(kindOf(msg(1, 0, { title: "Member roles updated" }))).toBe("member");
  expect(kindOf(msg(1, 0, { title: "Ticket #12 closed" }))).toBe("ticket");
  expect(kindOf(msg(1, 0, { title: null, attachments: ["ticket-12.zip"] }))).toBe("ticket");
  expect(kindOf(msg(1, 0, { title: "⚠️ Warn" }))).toBe("moderation");
});

function channel(messages: LogMessage[]): LogChannelApi & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async fetchBefore(before, limit) {
      return messages
        .filter((m) => BigInt(m.id) < BigInt(before) && !removed.includes(m.id))
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .slice(0, limit);
    },
    async remove(id) {
      removed.push(id);
    },
  };
}

test("only the bot's posts past their retention go, oldest kinds by their own cutoff", async () => {
  const cutoffs = { member: NOW - 90 * DAY, ticket: NOW - 365 * DAY, moderation: NOW - 365 * DAY };
  const ch = channel([
    msg(9, 100), // member, past 90 days: gone
    msg(8, 100, { authorId: "someone" }), // not the bot's: stays
    msg(7, 200, { title: "⚠️ Warn" }), // moderation, inside a year: stays
    msg(6, 400, { title: "⚠️ Warn" }), // moderation, past a year: gone
    msg(5, 200, { title: "Ticket #3 closed", attachments: ["ticket-3.zip"] }), // ticket, inside a year: stays
    msg(4, 10), // member, recent: stays
  ]);
  const deleted = await purgeChannel(ch, "bot", cutoffs, NOW, 500);
  expect(deleted).toBe(2);
  expect(ch.removed.sort()).toEqual(["6", "9"]);
});

test("a run stops at its cap", async () => {
  const cutoffs = { member: NOW - 90 * DAY, ticket: NOW, moderation: NOW };
  const ch = channel(Array.from({ length: 30 }, (_, i) => msg(100 + i, 100)));
  expect(await purgeChannel(ch, "bot", cutoffs, NOW, 7)).toBe(7);
});

test("the hourly run purges every guild the bot is in", async () => {
  const ctx = seed();
  const client = { user: { id: "bot" }, guilds: { cache: new Map([["g", { id: "g", channels: { fetch: async () => null } }]]) } };
  const { runRetention } = await import("../../src/lib/scheduler");
  await runRetention(ctx, client as never, NOW);
  expect(ctx.db.query("SELECT COUNT(*) AS n FROM cases WHERE guild_id = 'g'").get()).toEqual({ n: 1 });
});

test("verification posts are member-log posts", () => {
  expect(kindOf(msg(1, 0, { title: "Member verified" }))).toBe("member");
  expect(kindOf(msg(1, 0, { title: "Member manually verified" }))).toBe("member");
});

test("each run carries on from where the last stopped, so kept posts can't wall off old ones", async () => {
  const cutoffs = { member: NOW - 90 * DAY, ticket: NOW - 365 * DAY, moderation: NOW - 365 * DAY };
  const kept = Array.from({ length: 2500 }, (_, i) => msg(10_000 + i, 100, { title: "⚠️ Warn" })); // inside a year: kept
  const expired = Array.from({ length: 10 }, (_, i) => msg(100 + i, 400, { title: "⚠️ Warn" })); // past a year: due
  const ch = channel([...kept, ...expired]);
  const cursor = new Map<string, string>();
  let deleted = 0;
  for (let run = 0; run < 3; run++) deleted += await purgeChannel(ch, "bot", cutoffs, NOW, 500, 20, cursor, "logs");
  expect(deleted).toBe(10);
});
