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

export interface Challenge {
  code: string;
  expiresAt: number;
  dmMessageId?: string;
}

export function getChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
): Challenge | undefined {
  const row = one<{ code: string; expiresAt: number; dmMessageId: string | null }>(
    db,
    "SELECT code, expires_at AS expiresAt, dm_message_id AS dmMessageId FROM verification_challenges WHERE guild_id = ? AND user_id = ?",
    guildId,
    userId,
  );
  if (!row) return undefined;
  return { code: row.code, expiresAt: row.expiresAt, dmMessageId: row.dmMessageId ?? undefined };
}

// Record which DM message holds the captcha, so a code typed in a DM can rotate that
// message in place after a restart has dropped the in-memory session. Left untouched by
// setChallenge (code rotations keep editing the same message), so it persists across them.
export function setChallengeDmMessage(
  db: BotDatabase,
  guildId: string,
  userId: string,
  messageId: string,
): void {
  run(
    db,
    "UPDATE verification_challenges SET dm_message_id = ? WHERE guild_id = ? AND user_id = ?",
    messageId,
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
