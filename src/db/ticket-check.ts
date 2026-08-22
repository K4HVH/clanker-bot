import { type BotDatabase, one, run } from "../db/index";
import type { CheckResult } from "../lib/ticket-check";

// One row per member per guild: when they last passed the ticket intelligence check
// (for the pass-validity window) and when they last failed (for the cooldown). The
// in-flight challenge itself is deliberately not stored: losing one to a restart costs
// the member a click, and persisting it would mean reviving a half-answered quiz.

export function getCheckResult(
  db: BotDatabase,
  guildId: string,
  userId: string,
): CheckResult | undefined {
  return one<CheckResult>(
    db,
    `SELECT passed_at AS passedAt, failed_at AS failedAt, fails
     FROM ticket_check_results WHERE guild_id = ? AND user_id = ?`,
    guildId,
    userId,
  );
}

export function recordCheckPass(
  db: BotDatabase,
  guildId: string,
  userId: string,
  at: number,
): void {
  run(
    db,
    `INSERT INTO ticket_check_results (guild_id, user_id, passed_at, failed_at, fails)
     VALUES (?, ?, ?, NULL, 0)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET passed_at = excluded.passed_at,
       failed_at = NULL, fails = 0`,
    guildId,
    userId,
    at,
  );
}

// A failure clears any earlier pass. The gate honours a live pass ahead of a live
// cooldown, so leaving one behind would let a member who has since demonstrably failed
// walk straight past the cooldown that failure started.
export function recordCheckFail(
  db: BotDatabase,
  guildId: string,
  userId: string,
  at: number,
): void {
  run(
    db,
    `INSERT INTO ticket_check_results (guild_id, user_id, passed_at, failed_at, fails)
     VALUES (?, ?, NULL, ?, 1)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET failed_at = excluded.failed_at,
       passed_at = NULL, fails = fails + 1`,
    guildId,
    userId,
    at,
  );
}

// Staff clearing a member's state: drops the cooldown AND any recorded pass, so the
// next ticket they open starts the check from scratch.
export function clearCheckResult(db: BotDatabase, guildId: string, userId: string): void {
  run(db, "DELETE FROM ticket_check_results WHERE guild_id = ? AND user_id = ?", guildId, userId);
}
