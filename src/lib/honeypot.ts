import type { Message, PartialMessage } from "discord.js";
import type { AppContext } from "../core/context";
import { CONFIG_KEYS } from "./config";

// True when a channel IS the configured honeypot OR a thread whose parent is it. A thread's
// channel id isn't its parent's, so a plain `id === honeypotChannelId` check would let someone bait-post
// inside a thread and escape (and would leave automod un-exempted there). Mirrors verify-channel.
export function channelIsHoneypot(
  ctx: AppContext,
  guildId: string,
  channel: { id: string; isThread(): boolean; parentId?: string | null },
): boolean {
  const honeypotChannelId = ctx.config.get<string>(guildId, CONFIG_KEYS.honeypotChannelId);
  if (!honeypotChannelId) return false;
  if (channel.id === honeypotChannelId) return true;
  return channel.isThread() && channel.parentId === honeypotChannelId;
}

// True when a message lives in the honeypot channel (or a thread under it).
export function inHoneypotChannel(ctx: AppContext, message: Message | PartialMessage): boolean {
  const guildId = message.guildId;
  if (!guildId) return false;
  return channelIsHoneypot(ctx, guildId, message.channel);
}
