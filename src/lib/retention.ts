import { type Client, SnowflakeUtil } from "discord.js";
import type { AppContext } from "../core/context";
import { runChanges } from "../db/index";
import { CONFIG_KEYS } from "./config";
import { suppressDeletion } from "./log-suppress";

// Deletes what the bot recorded once its retention runs out: database rows, and the bot's posts
// in the mod and member logs. Discord's Developer Terms have a bot delete data it no longer needs;
// the retention settings say when that is.

const DAY_MS = 86_400_000;
// The longest a failed ticket check's cooldown runs (it doubles per failure, capped at a day).
const CHECK_COOLDOWN_MAX_MS = DAY_MS;

export function purgeRows(ctx: AppContext, guildId: string, now: number): { cases: number; tickets: number; checks: number } {
  const days = (key: string) => ctx.config.getEffective<number>(guildId, key);
  const caseCutoff = now - days(CONFIG_KEYS.retentionModerationDays) * DAY_MS;
  const ticketCutoff = now - days(CONFIG_KEYS.retentionTicketsDays) * DAY_MS;
  const passCutoff = now - days(CONFIG_KEYS.ticketCheckPassDays) * DAY_MS;
  // A signature seeded from a case outlives it: it describes the scam, not the member.
  runChanges(
    ctx.db,
    "UPDATE scam_signature SET case_id = NULL WHERE guild_id = ? AND case_id IN (SELECT id FROM cases WHERE guild_id = ? AND created_at < ?)",
    guildId,
    guildId,
    caseCutoff,
  );
  const cases = runChanges(ctx.db, "DELETE FROM cases WHERE guild_id = ? AND created_at < ?", guildId, caseCutoff);
  const tickets = runChanges(
    ctx.db,
    "DELETE FROM tickets WHERE guild_id = ? AND status = 'closed' AND closed_at < ?",
    guildId,
    ticketCutoff,
  );
  const checks = runChanges(
    ctx.db,
    `DELETE FROM ticket_check_results WHERE guild_id = ?
       AND (passed_at IS NULL OR passed_at < ?)
       AND (failed_at IS NULL OR failed_at < ?)`,
    guildId,
    passCutoff,
    now - CHECK_COOLDOWN_MAX_MS,
  );
  return { cases, tickets, checks };
}

export interface LogMessage {
  id: string;
  authorId: string;
  createdAt: number;
  title: string | null;
  attachments: string[];
}

export interface LogChannelApi {
  fetchBefore(before: string, limit: number): Promise<LogMessage[]>; // newest first
  remove(id: string): Promise<void>;
}

export type LogKind = "member" | "ticket" | "moderation";

// Titles of what the bot posts to the member log. Medius points both logs at one channel, so a
// post is sorted by what it records, not by where it sits.
const MEMBER_TITLES = new Set([
  "Message deleted",
  "Message edited",
  "Messages bulk-deleted",
  "Member joined",
  "Member left",
  "Member verified",
  "Member manually verified",
  "Nickname changed",
  "Member roles updated",
  "Channel created",
  "Channel deleted",
  "Channel updated",
  "Role created",
  "Role deleted",
  "Role updated",
]);

export function kindOf(m: LogMessage): LogKind {
  if (m.title && MEMBER_TITLES.has(m.title)) return "member";
  if ((m.title && /^Ticket #\d+/.test(m.title)) || m.attachments.some((a) => /^ticket-\d+\.(zip|txt)$/.test(a))) return "ticket";
  return "moderation";
}

// Walks back through a channel deleting the bot's posts past their cutoff, up to `cap` per run.
// Posts still kept (moderation inside its year, other people's messages) can fill many pages, so a
// run carries on from where the last one stopped (`cursor`, by channel) and starts again from the
// most recent cutoff once it reaches the channel's start. Older-than-14-days messages can't be bulk
// deleted, so a backlog clears over a few runs.
export async function purgeChannel(
  api: LogChannelApi,
  botId: string,
  cutoffs: Record<LogKind, number>,
  now: number,
  cap: number,
  maxPages = 20,
  cursor?: Map<string, string>,
  key = "",
): Promise<number> {
  const top = SnowflakeUtil.generate({ timestamp: Math.min(now, Math.max(...Object.values(cutoffs))) }).toString();
  let before = cursor?.get(key) ?? top;
  let deleted = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await api.fetchBefore(before, 100);
    if (batch.length === 0) {
      cursor?.delete(key); // reached the start: the next run begins at the top again
      return deleted;
    }
    for (const m of batch) {
      if (deleted >= cap) {
        cursor?.set(key, before);
        return deleted;
      }
      before = m.id;
      if (m.authorId !== botId || m.createdAt >= cutoffs[kindOf(m)]) continue;
      // One already gone (deleted by hand meanwhile) or refused doesn't stop the rest; a refused one
      // comes round again on a later run.
      try {
        await api.remove(m.id);
        deleted++;
      } catch {
        // next
      }
    }
  }
  cursor?.set(key, before);
  return deleted;
}

// Where each log channel's purge got to, by channel id. In memory: a restart starts from the top.
const cursors = new Map<string, string>();

export async function purgeLogPosts(ctx: AppContext, client: Client, guildId: string, now: number, cap = 500): Promise<number> {
  const botId = client.user?.id;
  const guild = client.guilds.cache.get(guildId);
  if (!botId || !guild) return 0;
  const days = (key: string) => ctx.config.getEffective<number>(guildId, key);
  const cutoffs: Record<LogKind, number> = {
    member: now - days(CONFIG_KEYS.retentionMemberLogDays) * DAY_MS,
    ticket: now - days(CONFIG_KEYS.retentionTicketsDays) * DAY_MS,
    moderation: now - days(CONFIG_KEYS.retentionModerationDays) * DAY_MS,
  };
  const ids = new Set(
    [CONFIG_KEYS.modLogChannelId, CONFIG_KEYS.memberLogChannelId]
      .map((k) => ctx.config.get<string>(guildId, k))
      .filter((id): id is string => !!id),
  );
  let deleted = 0;
  for (const id of ids) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;
    const api: LogChannelApi = {
      async fetchBefore(before, limit) {
        const page = await channel.messages.fetch({ before, limit });
        return [...page.values()].map((m) => ({
          id: m.id,
          authorId: m.author.id,
          createdAt: m.createdTimestamp,
          title: m.embeds[0]?.title ?? null,
          attachments: [...m.attachments.values()].map((a) => a.name),
        }));
      },
      async remove(messageId) {
        suppressDeletion(messageId);
        await channel.messages.delete(messageId);
      },
    };
    deleted += await purgeChannel(api, botId, cutoffs, now, cap - deleted, 20, cursors, id);
  }
  return deleted;
}
