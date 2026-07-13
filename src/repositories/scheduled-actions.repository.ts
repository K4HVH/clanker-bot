import { asc, eq, lte } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { scheduledActions } from "../db/schema";

export type ScheduledActionType = "unban";

export interface ScheduledAction {
  id: number;
  guildId: string;
  type: string;
  userId: string;
  reason: string | null;
  runAt: number;
  createdAt: number;
}

export function scheduleAction(
  db: BotDatabase,
  input: {
    guildId: string;
    type: ScheduledActionType;
    userId: string;
    reason?: string;
    runAt: number;
  },
): ScheduledAction {
  return db
    .insert(scheduledActions)
    .values({
      guildId: input.guildId,
      type: input.type,
      userId: input.userId,
      reason: input.reason ?? null,
      runAt: input.runAt,
      createdAt: Date.now(),
    })
    .returning()
    .get() as ScheduledAction;
}

export function dueActions(db: BotDatabase, now: number): ScheduledAction[] {
  return db
    .select()
    .from(scheduledActions)
    .where(lte(scheduledActions.runAt, now))
    .orderBy(asc(scheduledActions.runAt))
    .all() as ScheduledAction[];
}

export function deleteScheduledAction(db: BotDatabase, id: number): void {
  db.delete(scheduledActions).where(eq(scheduledActions.id, id)).run();
}
