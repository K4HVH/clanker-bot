import type { Message, PartialMessage } from "discord.js";
import type { AppContext } from "../core/context";
import { CONFIG_KEYS } from "./config";

// True when a channel IS the configured verify channel OR a thread whose parent is it.
// A thread's channel id isn't its parent's, so a plain `id === verifyChannelId` check would let
// thread activity bypass the scrub/skip.
export function channelIsVerify(
  ctx: AppContext,
  guildId: string,
  channel: { id: string; isThread(): boolean; parentId?: string | null },
): boolean {
  const verifyChannelId = ctx.config.get<string>(guildId, CONFIG_KEYS.verificationChannelId);
  if (!verifyChannelId) return false;
  if (channel.id === verifyChannelId) return true;
  return channel.isThread() && channel.parentId === verifyChannelId;
}

// True when a message lives in the verify channel (or a thread under it).
export function inVerifyChannel(ctx: AppContext, message: Message | PartialMessage): boolean {
  const guildId = message.guildId;
  if (!guildId) return false;
  return channelIsVerify(ctx, guildId, message.channel);
}
