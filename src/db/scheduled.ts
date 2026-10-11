import { type BotDatabase, many, one, run } from "../db/index";

export type ScheduledActionType = "unban";

export interface ScheduledAction {
  id: number;
  guildId: string;
  type: string;
  userId: string;
  reason: string | null;
  runAt: number;
  createdAt: number;
  quiet: boolean; // its member was forgotten: carry it out, record nothing
}

const COLUMNS = `id, guild_id AS guildId, type, user_id AS userId, reason,
  run_at AS runAt, created_at AS createdAt, quiet = 1 AS quiet`;

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
  const created = one<ScheduledAction>(
    db,
    `INSERT INTO scheduled_actions (guild_id, type, user_id, reason, run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    input.guildId,
    input.type,
    input.userId,
    input.reason ?? null,
    input.runAt,
    Date.now(),
  );
  if (!created) throw new Error("failed to schedule action");
  return created;
}

export function dueActions(db: BotDatabase, now: number): ScheduledAction[] {
  return many<ScheduledAction>(
    db,
    `SELECT ${COLUMNS} FROM scheduled_actions WHERE run_at <= ? ORDER BY run_at ASC`,
    now,
  );
}

export function deleteScheduledAction(db: BotDatabase, id: number): void {
  run(db, "DELETE FROM scheduled_actions WHERE id = ?", id);
}
