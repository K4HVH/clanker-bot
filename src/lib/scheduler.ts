import type { Client } from "discord.js";
import type { AppContext } from "../core/context";
import { createCase } from "../db/cases";
import { pruneExpiredSignatures } from "../db/scam-signature";
import {
  deleteScheduledAction,
  dueActions,
  type ScheduledAction,
  type ScheduledActionType,
} from "../db/scheduled";
import { pruneExpiredChallenges } from "../db/verification";
import { logCase } from "./modlog";
import { purgeLogPosts, purgeRows } from "./retention";

const RETENTION_EVERY_MS = 3_600_000;

export type ActionExecutor = (
  ctx: AppContext,
  client: Client,
  action: ScheduledAction,
) => Promise<void>;

export const defaultExecutors: Record<ScheduledActionType, ActionExecutor> = {
  unban: async (ctx, client, action) => {
    const guild = await client.guilds.fetch(action.guildId);
    await guild.bans.remove(action.userId, action.reason ?? "Temp-ban expired").catch(() => {});
    if (action.quiet) return; // forgotten at their request: lift the ban, write nothing about them
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

// Retention, for every guild the bot is in: rows first (cheap), then the log posts.
export async function runRetention(ctx: AppContext, client: Client, now: number): Promise<void> {
  for (const guildId of client.guilds.cache.keys()) {
    try {
      purgeRows(ctx, guildId, now);
      await purgeLogPosts(ctx, client, guildId, now);
    } catch (error) {
      ctx.logger.error("retention purge failed", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startScheduler(ctx: AppContext, client: Client, intervalMs = 30_000): () => void {
  let lastRetention = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastRetention >= RETENTION_EVERY_MS) {
      lastRetention = now;
      void runRetention(ctx, client, now);
    }
    void runDueActions(ctx, client, now);
    // Piggyback periodic DB hygiene on the same tick: clear expired captcha rows.
    // Guarded so a DB throw can't escape the timer callback and kill the process.
    try {
      pruneExpiredChallenges(ctx.db, now);
      pruneExpiredSignatures(ctx.db, now);
    } catch (error) {
      ctx.logger.error("prune expired rows failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
