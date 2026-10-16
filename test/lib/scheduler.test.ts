import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { scheduleAction } from "../../src/db/scheduled";
import { type ActionExecutor, runDueActions } from "../../src/lib/scheduler";
import { silentContext } from "../helpers/fakes";

test("runs and deletes only due actions", async () => {
  const ctx = silentContext();
  scheduleAction(ctx.db, { guildId: "g", type: "unban", userId: "u1", runAt: 100 });
  scheduleAction(ctx.db, { guildId: "g", type: "unban", userId: "u2", runAt: 5_000 });

  const ran: string[] = [];
  const executors: Record<string, ActionExecutor> = {
    unban: async (_c, _cl, action) => {
      ran.push(action.userId);
    },
  };

  const count = await runDueActions(ctx, {} as Client, 200, executors);
  expect(count).toBe(1);
  expect(ran).toEqual(["u1"]);

  const later = await runDueActions(ctx, {} as Client, 10_000, executors);
  expect(later).toBe(1);
  expect(ran).toEqual(["u1", "u2"]);
});

test("a failing executor does not block deletion of the action", async () => {
  const ctx = silentContext();
  scheduleAction(ctx.db, { guildId: "g", type: "unban", userId: "u", runAt: 1 });
  const executors: Record<string, ActionExecutor> = {
    unban: async () => {
      throw new Error("boom");
    },
  };
  const count = await runDueActions(ctx, {} as Client, 10, executors);
  expect(count).toBe(1);
  expect(await runDueActions(ctx, {} as Client, 10, executors)).toBe(0);
});

test("a quiet unban lifts the ban and records nothing", async () => {
  const { runDueActions } = await import("../../src/lib/scheduler");
  const { silentContext } = await import("../helpers/fakes");
  const { run } = await import("../../src/db/index");
  const ctx = silentContext();
  run(ctx.db, "INSERT INTO scheduled_actions (guild_id, type, user_id, reason, run_at, created_at, quiet) VALUES ('g', 'unban', 'u1', NULL, 1, 1, 1)");
  const removed: string[] = [];
  const client = { user: { id: "bot" }, guilds: { fetch: async () => ({ id: "g", bans: { remove: async (id: string) => void removed.push(id) } }) } };
  await runDueActions(ctx, client as never, 10);
  expect(removed).toEqual(["u1"]);
  expect(ctx.db.query("SELECT COUNT(*) AS n FROM cases").get()).toEqual({ n: 0 });
});
