import { type BotDatabase, one, run } from "../db/index";

export function setChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
  code: string,
  expiresAt: number,
): void {
  run(
    db,
    `INSERT INTO verification_challenges (guild_id, user_id, code, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`,
    guildId,
    userId,
    code,
    expiresAt,
  );
}

export function getChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
): { code: string; expiresAt: number } | undefined {
  return one<{ code: string; expiresAt: number }>(
    db,
    "SELECT code, expires_at AS expiresAt FROM verification_challenges WHERE guild_id = ? AND user_id = ?",
    guildId,
    userId,
  );
}

export function deleteChallenge(db: BotDatabase, guildId: string, userId: string): void {
  run(db, "DELETE FROM verification_challenges WHERE guild_id = ? AND user_id = ?", guildId, userId);
}

// Drop challenges whose TTL has elapsed. Rows are otherwise deleted only on a
// successful verify, so abandoned/expired ones would accumulate indefinitely.
export function pruneExpiredChallenges(db: BotDatabase, now: number): number {
  return db.query("DELETE FROM verification_challenges WHERE expires_at < ?").run(now).changes;
}
