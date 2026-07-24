import { ChannelType, type Guild, type GuildTextBasedChannel, PermissionFlagsBits } from "discord.js";
import { deleteSuppressed, suppressDeletion } from "./log-suppress";

const BULK_CUTOFF_MS = 14 * 24 * 60 * 60 * 1000; // Discord won't bulk-delete messages older than 14 days
const SCAN_PER_CHANNEL = 100; // one fetch page per channel; recent scam spam is always near the top

// Channels the bot can both read and delete in.
function purgeableChannels(guild: Guild): GuildTextBasedChannel[] {
  const me = guild.members.me;
  if (!me) return [];
  const out: GuildTextBasedChannel[] = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
    const perms = channel.permissionsFor(me);
    if (perms?.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.ManageMessages)) {
      out.push(channel);
    }
  }
  return out;
}

// Delete a user's messages from the last `sinceMs..now` across the guild's text channels. This
// gives an automatic kick the same "clean up their footprint" a ban gets from deleteMessageSeconds
// (Discord's kick API can't wipe messages itself). Best-effort and bounded: one page per channel
// and a wall-clock budget, so a spraying compromised account is cleaned without a runaway scan.
export async function purgeUserMessages(
  guild: Guild,
  userId: string,
  sinceMs: number,
  budgetMs = 8000,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let deleted = 0;
  for (const channel of purgeableChannels(guild)) {
    if (Date.now() >= deadline) break;
    const batch = await channel.messages.fetch({ limit: SCAN_PER_CHANNEL }).catch(() => null);
    if (!batch) continue;
    const mine = [...batch.values()].filter((m) => m.author.id === userId && m.createdTimestamp >= sinceMs);
    if (mine.length === 0) continue;
    for (const m of mine) suppressDeletion(m.id);

    const now = Date.now();
    const bulk = mine.filter((m) => now - m.createdTimestamp < BULK_CUTOFF_MS);
    const old = mine.filter((m) => now - m.createdTimestamp >= BULK_CUTOFF_MS);
    if (bulk.length >= 2) {
      const removed = await channel.bulkDelete(bulk, true).catch(() => null);
      deleted += removed?.size ?? 0;
    } else {
      for (const m of bulk) if (await deleteSuppressed(m.id, () => m.delete())) deleted++;
    }
    for (const m of old) {
      if (Date.now() >= deadline) break;
      if (await deleteSuppressed(m.id, () => m.delete())) deleted++;
    }
  }
  return deleted;
}
