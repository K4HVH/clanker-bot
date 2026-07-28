import { EmbedBuilder, type Guild, type MessageCreateOptions } from "discord.js";
import type { AppContext } from "../core/context";
import type { CaseRecord } from "../db/cases";
import { CONFIG_KEYS } from "./config";

const ACTION_META: Record<string, { emoji: string; label: string; color: number }> = {
  warn: { emoji: "⚠️", label: "Warn", color: 0xf1c40f },
  timeout: { emoji: "⏳", label: "Timeout", color: 0xe67e22 },
  untimeout: { emoji: "✅", label: "Timeout lifted", color: 0x2ecc71 },
  kick: { emoji: "👢", label: "Kick", color: 0xe74c3c },
  ban: { emoji: "🔨", label: "Ban", color: 0x992d22 },
  unban: { emoji: "🕊️", label: "Unban", color: 0x2ecc71 },
  note: { emoji: "📝", label: "Note", color: 0x95a5a6 },
};

function truncate(text: string, max = 1024): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A single moderation action, for the mod-log. No case number — the action speaks for itself.
export function buildCaseEmbed(c: CaseRecord): EmbedBuilder {
  const m = ACTION_META[c.type] ?? { emoji: "•", label: c.type, color: 0x95a5a6 };
  return new EmbedBuilder()
    .setColor(m.color)
    .setTitle(`${m.emoji} ${m.label}`)
    .addFields(
      { name: "User", value: `<@${c.userId}> (${c.userId})` },
      { name: "Moderator", value: `<@${c.moderatorId}>` },
      { name: "Reason", value: truncate(c.reason) },
    )
    .setTimestamp(new Date(c.createdAt));
}

export function buildMessageDeleteEmbed(a: {
  authorId?: string;
  channelId: string;
  content: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Message deleted")
    .addFields(
      { name: "Author", value: a.authorId ? `<@${a.authorId}>` : "*(unknown)*" },
      { name: "Channel", value: `<#${a.channelId}>` },
      { name: "Content", value: truncate(a.content) },
    );
}

export function buildMessageUpdateEmbed(a: {
  authorId?: string;
  channelId: string;
  before: string;
  after: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Message edited")
    .addFields(
      { name: "Author", value: a.authorId ? `<@${a.authorId}>` : "*(unknown)*" },
      { name: "Channel", value: `<#${a.channelId}>` },
      { name: "Before", value: truncate(a.before) },
      { name: "After", value: truncate(a.after) },
    );
}

export function buildMemberJoinEmbed(a: { userId: string; createdAt: number }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("Member joined")
    .addFields(
      { name: "User", value: `<@${a.userId}> (${a.userId})` },
      { name: "Account created", value: `<t:${Math.floor(a.createdAt / 1000)}:R>` },
    );
}

// Tenure and roles are only knowable while the departing member is still resolvable — a member
// who has left can't be fetched afterwards, and an uncached one arrives with the user alone.
// Those fields are therefore optional, and render as "unknown" rather than being quietly omitted:
// an absent field would read as "no roles" when it means "we couldn't tell".
export function buildMemberLeaveEmbed(a: {
  userId: string;
  createdAt?: number;
  joinedAt?: number | null;
  roleIds?: string[];
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Member left")
    .addFields({ name: "User", value: `<@${a.userId}> (${a.userId})` });
  if (a.createdAt !== undefined) {
    embed.addFields({
      name: "Account created",
      value: `<t:${Math.floor(a.createdAt / 1000)}:R>`,
    });
  }
  const joined = Math.floor((a.joinedAt ?? 0) / 1000);
  embed.addFields({
    name: "Joined server",
    value: a.joinedAt ? `<t:${joined}:D> (<t:${joined}:R>)` : "*unknown*",
  });
  embed.addFields({
    name: "Roles held",
    value: a.roleIds
      ? a.roleIds.length > 0
        ? truncate(a.roleIds.map((id) => `<@&${id}>`).join(" "))
        : "*none*"
      : "*unknown*",
  });
  return embed.setTimestamp(new Date());
}

export function buildBulkDeleteEmbed(a: { channelId: string; count: number }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Messages bulk-deleted")
    .addFields(
      { name: "Channel", value: `<#${a.channelId}>` },
      { name: "Count", value: `${a.count}`, inline: true },
    );
}

export function buildNicknameEmbed(a: {
  userId: string;
  before: string | null;
  after: string | null;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Nickname changed")
    .addFields(
      { name: "User", value: `<@${a.userId}> (${a.userId})` },
      { name: "Before", value: a.before ?? "*(none)*" },
      { name: "After", value: a.after ?? "*(none)*" },
    );
}

type ExtraSend = {
  content?: string;
  allowedMentions?: { roles: string[] };
  components?: MessageCreateOptions["components"];
};

async function sendToConfigured(
  ctx: AppContext,
  guild: Guild,
  key: string,
  embed: EmbedBuilder,
  extra?: ExtraSend,
): Promise<void> {
  const channelId = ctx.config.get<string>(guild.id, key);
  if (!channelId) return; // unset is a deliberate opt-out, not a failure
  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  // Past this point the operator has asked for these logs, so a drop is a fault worth
  // surfacing: a silent one is indistinguishable from "nothing happened", which makes a
  // missing log line impossible to diagnose from the outside.
  if (!channel?.isTextBased()) {
    ctx.logger.warn("log channel is missing or not text-based — dropped a log line", {
      guildId: guild.id,
      setting: key,
      channelId,
    });
    return;
  }
  await channel.send({ embeds: [embed], ...extra }).catch((error: unknown) => {
    ctx.logger.warn("could not post to the log channel — dropped a log line", {
      guildId: guild.id,
      setting: key,
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function logCase(ctx: AppContext, guild: Guild, c: CaseRecord): Promise<void> {
  await sendToConfigured(ctx, guild, CONFIG_KEYS.modLogChannelId, buildCaseEmbed(c));
}

export async function logMemberEvent(
  ctx: AppContext,
  guild: Guild,
  embed: EmbedBuilder,
): Promise<void> {
  await sendToConfigured(ctx, guild, CONFIG_KEYS.memberLogChannelId, embed);
}

export async function logModAlert(
  ctx: AppContext,
  guild: Guild,
  embed: EmbedBuilder,
  opts?: { pingRoleId?: string; components?: MessageCreateOptions["components"] },
): Promise<void> {
  const extra: ExtraSend = { components: opts?.components };
  if (opts?.pingRoleId) {
    extra.content = `<@&${opts.pingRoleId}>`;
    extra.allowedMentions = { roles: [opts.pingRoleId] };
  }
  await sendToConfigured(ctx, guild, CONFIG_KEYS.modLogChannelId, embed, extra);
}
