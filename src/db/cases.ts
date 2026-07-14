import { type BotDatabase, many, one } from "../db/index";

export type CaseType = "warn" | "timeout" | "kick" | "ban" | "unban" | "note";

export interface NewCase {
  guildId: string;
  userId: string;
  moderatorId: string;
  type: CaseType;
  reason: string;
  meta?: unknown;
}

export interface CaseRecord {
  id: number;
  guildId: string;
  caseNumber: number;
  userId: string;
  moderatorId: string;
  type: string;
  reason: string;
  meta: string | null;
  createdAt: number;
}

const COLUMNS = `id, guild_id AS guildId, case_number AS caseNumber, user_id AS userId,
  moderator_id AS moderatorId, type, reason, meta, created_at AS createdAt`;

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
      `INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      i.guildId,
      nextNumber,
      i.userId,
      i.moderatorId,
      i.type,
      i.reason,
      i.meta === undefined ? null : JSON.stringify(i.meta),
      Date.now(),
    );
    if (!created) throw new Error("failed to insert case");
    return created;
  });
  return insert(input);
}

export function getCaseByNumber(
  db: BotDatabase,
  guildId: string,
  caseNumber: number,
): CaseRecord | undefined {
  return one<CaseRecord>(
    db,
    `SELECT ${COLUMNS} FROM cases WHERE guild_id = ? AND case_number = ?`,
    guildId,
    caseNumber,
  );
}

export function listCasesByUser(
  db: BotDatabase,
  guildId: string,
  userId: string,
  limit = 10,
): CaseRecord[] {
  return many<CaseRecord>(
    db,
    `SELECT ${COLUMNS} FROM cases WHERE guild_id = ? AND user_id = ? ORDER BY case_number DESC LIMIT ?`,
    guildId,
    userId,
    limit,
  );
}
