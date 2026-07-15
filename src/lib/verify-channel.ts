import type { Message, PartialMessage } from "discord.js";
import type { AppContext } from "../core/context";
import { CONFIG_KEYS } from "./config";

// True when a message lives in the configured verify channel OR in a thread whose
// parent is that channel. Threads have their own channel id, so a plain
// `channelId === verifyChannelId` check would let thread spam bypass the scrub.
export function inVerifyChannel(ctx: AppContext, message: Message | PartialMessage): boolean {
  const guildId = message.guildId;
  if (!guildId) return false;
  const verifyChannelId = ctx.config.get<string>(guildId, CONFIG_KEYS.verificationChannelId);
  if (!verifyChannelId) return false;
  if (message.channelId === verifyChannelId) return true;
  const channel = message.channel;
  return channel.isThread() && channel.parentId === verifyChannelId;
}
