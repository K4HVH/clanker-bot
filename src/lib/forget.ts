import { type Guild, SnowflakeUtil } from "discord.js";
import type { AppContext } from "../core/context";
import { type BotDatabase, runChanges } from "../db/index";
import { CONFIG_KEYS } from "./config";
import { suppressDeletion } from "./log-suppress";

// /mod forget: deletes everything the bot holds on one member, at their request. Discord's
// Developer Terms have a bot delete a user's data when they ask. Bans and timeouts stay: Discord
// holds those, not the bot. A pending temp-ban expiry stays until it lifts the ban.

export interface ForgetRows {
  cases: number;
  tickets: number;
  checks: number;
  challenges: number;
  scheduled: number;
  signatures: number;
}

export function forgetRows(db: BotDatabase, guildId: string, userId: string): ForgetRows {
  const del = (sql: string, ...params: (string | number)[]) => runChanges(db, sql, ...params);
  // A signature seeded from their case describes the scam, not them: it stays, unlinked.
  const signatures = del(
    "UPDATE scam_signature SET case_id = NULL WHERE guild_id = ? AND case_id IN (SELECT id FROM cases WHERE guild_id = ? AND user_id = ?)",
    guildId,
    guildId,
    userId,
  );
  // An unban stays, even one overdue but not yet run, or the ban would never lift. It goes quiet:
  // it lifts the ban without writing a case or posting about them.
  del("UPDATE scheduled_actions SET quiet = 1, reason = NULL WHERE guild_id = ? AND user_id = ? AND type = 'unban'", guildId, userId);
  return {
    cases: del("DELETE FROM cases WHERE guild_id = ? AND user_id = ?", guildId, userId),
    tickets: del("DELETE FROM tickets WHERE guild_id = ? AND opener_id = ?", guildId, userId),
    checks: del("DELETE FROM ticket_check_results WHERE guild_id = ? AND user_id = ?", guildId, userId),
    challenges: del("DELETE FROM verification_challenges WHERE guild_id = ? AND user_id = ?", guildId, userId),
    scheduled: del("DELETE FROM scheduled_actions WHERE guild_id = ? AND user_id = ? AND type <> 'unban'", guildId, userId),
    signatures,
  };
}

export interface ScanMessage {
  id: string;
  authorId: string;
  text: string; // content and embeds, as JSON
}

export interface ScanChannel {
  label: string;
  fetchBefore(before: string | undefined, limit: number): Promise<ScanMessage[]>; // newest first
  remove(id: string): Promise<void>;
}

// Every message of the bot's in these channels that `match` picks, back to `oldest` (a message id;
// retention has already deleted anything older). A channel the bot can't read is reported by label
// and the rest still run; a delete that fails (already gone, say) is counted and the scan goes on.
export async function forgetIn(
  channels: ScanChannel[],
  botId: string,
  match: (m: ScanMessage) => boolean,
  oldest?: string,
): Promise<{ deleted: number; failed: number; unreachable: string[] }> {
  let deleted = 0;
  let failed = 0;
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
          try {
            await channel.remove(m.id);
            deleted++;
          } catch {
            failed++;
          }
        }
        before = page[page.length - 1]!.id;
      }
    } catch {
      unreachable.push(channel.label);
    }
  }
  return { deleted, failed, unreachable };
}

// Embed fields naming who acted rather than who it was about. A post naming someone only there
// records another member's case, so it isn't theirs to have deleted.
const ACTOR_FIELDS = new Set(["Moderator", "By", "Closed by"]);

interface EmbedJson {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
}

export function subjectText(content: string, embeds: EmbedJson[]): string {
  const parts = [content];
  for (const e of embeds) {
    parts.push(e.title ?? "", e.description ?? "");
    for (const f of e.fields ?? []) if (!ACTOR_FIELDS.has(f.name)) parts.push(`${f.name}: ${f.value}`);
  }
  return parts.join("\n");
}

type Fetchable = {
  messages: {
    fetch(o: { before?: string; limit: number }): Promise<Map<string, { id: string; author: { id: string }; content: string; embeds: { toJSON(): unknown }[] }>>;
    delete(id: string): Promise<unknown>;
  };
};

export function scanOf(label: string, channel: Fetchable): ScanChannel {
  return {
    label,
    async fetchBefore(before, limit) {
      const page = await channel.messages.fetch(before ? { before, limit } : { limit });
      return [...page.values()].map((m) => ({
        id: m.id,
        authorId: m.author.id,
        text: subjectText(m.content, m.embeds.map((e) => e.toJSON() as EmbedJson)),
      }));
    },
    async remove(id) {
      suppressDeletion(id);
      await channel.messages.delete(id);
    },
  };
}

export async function forgetPosts(
  ctx: AppContext,
  guild: Guild,
  userId: string,
): Promise<{ logPosts: number; dms: number; failed: number; unreachable: string[] }> {
  const botId = guild.client.user.id;
  // Retention has deleted what's older than the longest retention, so the scan stops there.
  const days = Math.max(
    ...[CONFIG_KEYS.retentionModerationDays, CONFIG_KEYS.retentionTicketsDays, CONFIG_KEYS.retentionMemberLogDays].map((k) =>
      ctx.config.getEffective<number>(guild.id, k),
    ),
  );
  const oldest = SnowflakeUtil.generate({ timestamp: Date.now() - days * 86_400_000 }).toString();
  const ids = new Set(
    [CONFIG_KEYS.modLogChannelId, CONFIG_KEYS.memberLogChannelId]
      .map((k) => ctx.config.get<string>(guild.id, k))
      .filter((id): id is string => !!id),
  );
  const logs: ScanChannel[] = [];
  const unreachable: string[] = [];
  for (const id of ids) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel?.isTextBased()) logs.push(scanOf(`#${channel.name}`, channel as unknown as Fetchable));
    else unreachable.push(`<#${id}>`);
  }
  // Log posts carry the member as "name (id)"; a bare id match is the one test that finds them all.
  const fromLogs = await forgetIn(logs, botId, (m) => m.text.includes(userId), oldest);

  const dm = await guild.client.users
    .fetch(userId)
    .then((u) => u.createDM())
    .catch(() => null);
  const fromDms = dm
    ? await forgetIn([scanOf("DMs", dm as unknown as Fetchable)], botId, () => true)
    : { deleted: 0, failed: 0, unreachable: ["DMs"] };
  return {
    logPosts: fromLogs.deleted,
    dms: fromDms.deleted,
    failed: fromLogs.failed + fromDms.failed,
    unreachable: [...unreachable, ...fromLogs.unreachable, ...fromDms.unreachable],
  };
}
