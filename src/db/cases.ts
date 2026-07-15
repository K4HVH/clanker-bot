import { type BotDatabase, many, one, runChanges } from "../db/index";

// Delete a user's moderation history. automodOnly restricts to the bot-authored warns (automod
// violations) — resets the escalation ladder without wiping manual actions. Returns the count.
export function clearCases(
  db: BotDatabase,
  guildId: string,
  userId: string,
  opts: { automodOnly: boolean; botId: string },
): number {
  if (opts.automodOnly) {
    return runChanges(
      db,
      "DELETE FROM cases WHERE guild_id = ? AND user_id = ? AND moderator_id = ? AND type = 'warn'",
      guildId,
      userId,
      opts.botId,
    );
  }
  return runChanges(db, "DELETE FROM cases WHERE guild_id = ? AND user_id = ?", guildId, userId);
}

// Count a user's automod violations (bot-authored warns — the only bot-created warns) since a
// cutoff, for automod's escalation ladder.
export function countAutomodViolations(
  db: BotDatabase,
  guildId: string,
  userId: string,
  botId: string,
  sinceMs: number,
): number {
  return (
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM cases
       WHERE guild_id = ? AND user_id = ? AND moderator_id = ? AND type = 'warn' AND created_at >= ?`,
      guildId,
      userId,
      botId,
      sinceMs,
    )?.n ?? 0
  );
}

// The automod actions (bot-authored punitive cases) still inside the memory window, used to
// derive the escalation ladder position + burst cooldown from the DB (so it survives restarts
// and history clears). Most recent first.
export function listAutomodActions(
  db: BotDatabase,
  guildId: string,
  userId: string,
  botId: string,
  sinceMs: number,
): { type: string; createdAt: number }[] {
  return many<{ type: string; createdAt: number }>(
    db,
    `SELECT type, created_at AS createdAt FROM cases
     WHERE guild_id = ? AND user_id = ? AND moderator_id = ?
       AND type IN ('timeout', 'kick', 'ban') AND created_at >= ?`,
    guildId,
    userId,
    botId,
    sinceMs,
  );
}

export type CaseType = "warn" | "timeout" | "untimeout" | "kick" | "ban" | "unban" | "note";

export interface NewCase {
  guildId: string;
  userId: string;
  moderatorId: string;
  type: CaseType;
  reason: string;
}

export interface CaseRecord {
  id: number;
  guildId: string;
  caseNumber: number;
  userId: string;
  moderatorId: string;
  type: string;
  reason: string;
  createdAt: number;
}

const COLUMNS = `id, guild_id AS guildId, case_number AS caseNumber, user_id AS userId,
  moderator_id AS moderatorId, type, reason, created_at AS createdAt`;

// Record one moderation action against a user. case_number is an internal per-guild sequence
// (kept for stable ordering); it isn't surfaced — the user-facing view is just the history.
export function createCase(db: BotDatabase, input: NewCase): CaseRecord {
  const insert = db.transaction((i: NewCase): CaseRecord => {
    const row = one<{ max: number | null }>(
      db,
      "SELECT MAX(case_number) AS max FROM cases WHERE guild_id = ?",
      i.guildId,
    );
    const nextNumber = (row?.max ?? 0) + 1;
    const created = one<CaseRecord>(
      db,
      `INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      i.guildId,
      nextNumber,
      i.userId,
      i.moderatorId,
      i.type,
      i.reason,
      Date.now(),
    );
    if (!created) throw new Error("failed to insert case");
    return created;
  });
  return insert(input);
}

// A user's moderation history, most recent first.
export function listCasesByUser(
  db: BotDatabase,
  guildId: string,
  userId: string,
  limit = 15,
): CaseRecord[] {
  return many<CaseRecord>(
    db,
    `SELECT ${COLUMNS} FROM cases WHERE guild_id = ? AND user_id = ? ORDER BY case_number DESC LIMIT ?`,
    guildId,
    userId,
    limit,
  );
}
