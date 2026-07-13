import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { scheduleAction } from "../../src/repositories/scheduled-actions.repository";
import { type ActionExecutor, runDueActions } from "../../src/services/scheduler.service";
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
