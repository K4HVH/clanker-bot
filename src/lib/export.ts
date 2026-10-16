import { type Guild, SnowflakeUtil } from "discord.js";
import type { AppContext } from "../core/context";
import { type BotDatabase, many } from "../db/index";
import { logScans, namesMember, type ScanChannel, type ScanMessage } from "./forget";

// /mod export: a copy of everything the bot holds on one member, at their request: the same rows and
// posts /mod forget deletes. Who acted on them (a case's moderator, who closed a ticket) is another
// member's data, and a captcha's answer is a secret, so neither is in it.

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function memberRows(db: BotDatabase, guildId: string, userId: string) {
  const rows = <T>(sql: string) => many<T>(db, sql, guildId, userId);
  return {
    cases: rows<{ number: number; type: string; reason: string; at: number }>(
      "SELECT case_number AS number, type, reason, created_at AS at FROM cases WHERE guild_id = ? AND user_id = ? ORDER BY case_number",
    ).map((c) => ({ ...c, at: iso(c.at) })),
    tickets: rows<{ number: number; subject: string; status: string; opened: number; closed: number | null; closeReason: string | null; transcript: string | null }>(
      `SELECT ticket_number AS number, subject, status, created_at AS opened, closed_at AS closed, close_reason AS closeReason, transcript
       FROM tickets WHERE guild_id = ? AND opener_id = ? ORDER BY ticket_number`,
    ).map((t) => ({ ...t, opened: iso(t.opened), closed: iso(t.closed) })),
    ticketChecks: rows<{ passed: number | null; failed: number | null; failsInARow: number }>(
      "SELECT passed_at AS passed, failed_at AS failed, fails AS failsInARow FROM ticket_check_results WHERE guild_id = ? AND user_id = ?",
    ).map((c) => ({ ...c, passed: iso(c.passed), failed: iso(c.failed) })),
    captcha: rows<{ expires: number; wrongGuesses: number }>(
      "SELECT expires_at AS expires, attempts AS wrongGuesses FROM verification_challenges WHERE guild_id = ? AND user_id = ?",
    ).map((c) => ({ ...c, expires: iso(c.expires) })),
    scheduled: rows<{ action: string; reason: string | null; at: number }>(
      "SELECT type AS action, reason, run_at AS at FROM scheduled_actions WHERE guild_id = ? AND user_id = ? ORDER BY run_at",
    ).map((s) => ({ ...s, at: iso(s.at) })),
  };
}

export interface PostCopy {
  channel: string;
  id: string;
  at: string;
  text: string;
}

// The bot's posts in these channels that `match` picks, newest first, back to `oldest`. A channel the
// bot can't read is reported by label and the rest still run.
export async function collectIn(
  channels: ScanChannel[],
  botId: string,
  match: (m: ScanMessage) => boolean,
  oldest?: string,
): Promise<{ posts: PostCopy[]; unreachable: string[] }> {
  const posts: PostCopy[] = [];
  const unreachable: string[] = [];
  for (const channel of channels) {
    try {
      let before: string | undefined;
      scan: for (;;) {
        const page = await channel.fetchBefore(before, 100);
        if (page.length === 0) break;
        for (const m of page) {
          if (oldest !== undefined && BigInt(m.id) < BigInt(oldest)) break scan;
          if (m.authorId !== botId || !match(m)) continue;
          posts.push({ channel: channel.label, id: m.id, at: new Date(SnowflakeUtil.timestampFrom(m.id)).toISOString(), text: m.text });
        }
        before = page[page.length - 1]!.id;
      }
    } catch {
      unreachable.push(channel.label);
    }
  }
  return { posts, unreachable };
}

export async function memberPosts(ctx: AppContext, guild: Guild, userId: string): Promise<{ posts: PostCopy[]; unreachable: string[] }> {
  const { logs, unreachable, oldest } = await logScans(ctx, guild);
  const found = await collectIn(logs, guild.client.user.id, namesMember(userId), oldest);
  return { posts: found.posts, unreachable: [...unreachable, ...found.unreachable] };
}
