import { EmbedBuilder, type Guild } from "discord.js";
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

export function buildMemberLeaveEmbed(a: { userId: string }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Member left")
    .addFields({ name: "User", value: `<@${a.userId}> (${a.userId})` });
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

async function sendToConfigured(
  ctx: AppContext,
  guild: Guild,
  key: string,
  embed: EmbedBuilder,
): Promise<void> {
  const channelId = ctx.config.get<string>(guild.id, key);
  if (!channelId) return;
  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch(() => {});
  }
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
): Promise<void> {
  await sendToConfigured(ctx, guild, CONFIG_KEYS.modLogChannelId, embed);
}
