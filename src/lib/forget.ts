import type { Guild } from "discord.js";
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

export function forgetRows(db: BotDatabase, guildId: string, userId: string, now: number): ForgetRows {
  const del = (sql: string, ...params: (string | number)[]) => runChanges(db, sql, ...params);
  // A signature seeded from their case describes the scam, not them: it stays, unlinked.
  const signatures = del(
    "UPDATE scam_signature SET case_id = NULL WHERE guild_id = ? AND case_id IN (SELECT id FROM cases WHERE guild_id = ? AND user_id = ?)",
    guildId,
    guildId,
    userId,
  );
  return {
    cases: del("DELETE FROM cases WHERE guild_id = ? AND user_id = ?", guildId, userId),
    tickets: del("DELETE FROM tickets WHERE guild_id = ? AND opener_id = ?", guildId, userId),
    checks: del("DELETE FROM ticket_check_results WHERE guild_id = ? AND user_id = ?", guildId, userId),
    challenges: del("DELETE FROM verification_challenges WHERE guild_id = ? AND user_id = ?", guildId, userId),
    scheduled: del(
      "DELETE FROM scheduled_actions WHERE guild_id = ? AND user_id = ? AND NOT (type = 'unban' AND run_at > ?)",
      guildId,
      userId,
      now,
    ),
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

// Every message of the bot's in these channels that `match` picks, all the way back. A channel the
// bot can't read is reported by label and the rest still run.
export async function forgetIn(
  channels: ScanChannel[],
  botId: string,
  match: (m: ScanMessage) => boolean,
): Promise<{ deleted: number; unreachable: string[] }> {
  let deleted = 0;
  const unreachable: string[] = [];
  for (const channel of channels) {
    try {
      let before: string | undefined;
      for (;;) {
        const page = await channel.fetchBefore(before, 100);
        if (page.length === 0) break;
        for (const m of page) {
          if (m.authorId !== botId || !match(m)) continue;
          await channel.remove(m.id);
          deleted++;
        }
        before = page[page.length - 1]!.id;
      }
    } catch {
      unreachable.push(channel.label);
    }
  }
  return { deleted, unreachable };
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
        text: `${m.content}\n${JSON.stringify(m.embeds.map((e) => e.toJSON()))}`,
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
): Promise<{ logPosts: number; dms: number; unreachable: string[] }> {
  const botId = guild.client.user.id;
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
  const fromLogs = await forgetIn(logs, botId, (m) => m.text.includes(userId));

  const dm = await guild.client.users
    .fetch(userId)
    .then((u) => u.createDM())
    .catch(() => null);
  const fromDms = dm ? await forgetIn([scanOf("DMs", dm as unknown as Fetchable)], botId, () => true) : { deleted: 0, unreachable: ["DMs"] };
  return {
    logPosts: fromLogs.deleted,
    dms: fromDms.deleted,
    unreachable: [...unreachable, ...fromLogs.unreachable, ...fromDms.unreachable],
  };
}
