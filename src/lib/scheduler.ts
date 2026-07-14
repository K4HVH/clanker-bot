import type { Client } from "discord.js";
import type { AppContext } from "../core/context";
import { createCase } from "../db/cases";
import {
  deleteScheduledAction,
  dueActions,
  type ScheduledAction,
  type ScheduledActionType,
} from "../db/scheduled";
import { pruneExpiredChallenges } from "../db/verification";
import { logCase } from "./modlog";

export type ActionExecutor = (
  ctx: AppContext,
  client: Client,
  action: ScheduledAction,
) => Promise<void>;

export const defaultExecutors: Record<ScheduledActionType, ActionExecutor> = {
  unban: async (ctx, client, action) => {
    const guild = await client.guilds.fetch(action.guildId);
    await guild.bans.remove(action.userId, action.reason ?? "Temp-ban expired").catch(() => {});
    const record = createCase(ctx.db, {
      guildId: action.guildId,
      userId: action.userId,
      moderatorId: client.user?.id ?? "system",
      type: "unban",
      reason: action.reason ?? "Temp-ban expired",
    });
    await logCase(ctx, guild, record);
  },
};

export async function runDueActions(
  ctx: AppContext,
  client: Client,
  now: number,
  executors: Record<string, ActionExecutor> = defaultExecutors,
): Promise<number> {
  const due = dueActions(ctx.db, now);
  for (const action of due) {
    const exec = executors[action.type];
    if (exec) {
      try {
        await exec(ctx, client, action);
      } catch (error) {
        ctx.logger.error("scheduled action failed", {
          id: action.id,
          type: action.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    deleteScheduledAction(ctx.db, action.id);
  }
  return due.length;
}

export function startScheduler(ctx: AppContext, client: Client, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    void runDueActions(ctx, client, now);
    // Piggyback periodic DB hygiene on the same tick: clear expired captcha rows.
    // Guarded so a DB throw can't escape the timer callback and kill the process.
    try {
      pruneExpiredChallenges(ctx.db, now);
    } catch (error) {
      ctx.logger.error("prune expired challenges failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
