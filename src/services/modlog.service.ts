import { EmbedBuilder, type Guild } from "discord.js";
import type { AppContext } from "../core/context";
import type { CaseRecord } from "../repositories/cases.repository";
import { CONFIG_KEYS } from "./config.service";

const CASE_COLORS: Record<string, number> = {
  warn: 0xf1c40f,
  timeout: 0xe67e22,
  kick: 0xe74c3c,
  ban: 0x992d22,
  unban: 0x2ecc71,
  note: 0x95a5a6,
};

function truncate(text: string, max = 1024): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildCaseEmbed(c: CaseRecord): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(CASE_COLORS[c.type] ?? 0x95a5a6)
    .setTitle(`Case #${c.caseNumber} · ${c.type.toUpperCase()}`)
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
