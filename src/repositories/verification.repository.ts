import { and, eq } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { verificationChallenges } from "../db/schema";

export function setChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
  code: string,
  expiresAt: number,
): void {
  db.insert(verificationChallenges)
    .values({ guildId, userId, code, expiresAt })
    .onConflictDoUpdate({
      target: [verificationChallenges.guildId, verificationChallenges.userId],
      set: { code, expiresAt },
    })
    .run();
}

export function getChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
): { code: string; expiresAt: number } | undefined {
  return db
    .select({ code: verificationChallenges.code, expiresAt: verificationChallenges.expiresAt })
    .from(verificationChallenges)
    .where(
      and(eq(verificationChallenges.guildId, guildId), eq(verificationChallenges.userId, userId)),
    )
    .get();
}

export function deleteChallenge(db: BotDatabase, guildId: string, userId: string): void {
  db.delete(verificationChallenges)
    .where(
      and(eq(verificationChallenges.guildId, guildId), eq(verificationChallenges.userId, userId)),
    )
    .run();
}
