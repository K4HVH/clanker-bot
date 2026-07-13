import { and, desc, eq, sql } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { cases } from "../db/schema";

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

export function createCase(db: BotDatabase, input: NewCase): CaseRecord {
  return db.transaction((tx) => {
    const row = tx
      .select({ max: sql<number | null>`max(${cases.caseNumber})` })
      .from(cases)
      .where(eq(cases.guildId, input.guildId))
      .get();
    const nextNumber = (row?.max ?? 0) + 1;
    const inserted = tx
      .insert(cases)
      .values({
        guildId: input.guildId,
        caseNumber: nextNumber,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason,
        meta: input.meta === undefined ? null : JSON.stringify(input.meta),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return inserted as CaseRecord;
  });
}

export function getCaseByNumber(
  db: BotDatabase,
  guildId: string,
  caseNumber: number,
): CaseRecord | undefined {
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.guildId, guildId), eq(cases.caseNumber, caseNumber)))
    .get() as CaseRecord | undefined;
}

export function listCasesByUser(
  db: BotDatabase,
  guildId: string,
  userId: string,
  limit = 10,
): CaseRecord[] {
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.guildId, guildId), eq(cases.userId, userId)))
    .orderBy(desc(cases.caseNumber))
    .limit(limit)
    .all() as CaseRecord[];
}
