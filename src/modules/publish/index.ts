import { ChannelType, Events, type Message, MessageFlags } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { channelSpecFor } from "../../server/runtime";
import type { ServerSpec } from "../../server/spec";
import { SPECS } from "../../server/specs";

// Publishes what's posted in an announcement channel the spec marks `publish`, so servers following it
// get it: a webhook's release post is never published by Discord on its own. A silent post (a backfill
// of older releases) stays in the channel.
export async function maybePublish(ctx: AppContext, message: Message, specs: Record<string, ServerSpec> = SPECS): Promise<void> {
  if (!message.guildId || message.channel.type !== ChannelType.GuildAnnouncement) return;
  if (message.flags.has(MessageFlags.Crossposted) || message.flags.has(MessageFlags.SuppressNotifications)) return;
  if (!channelSpecFor(ctx.db, message.guildId, message.channelId, specs)?.publish) return;
  await message.crosspost().catch((error: unknown) => {
    ctx.logger.warn("couldn't publish an announcement", {
      channelId: message.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

const onMessage: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    await maybePublish(ctx, message);
  },
};

export const publishModule: BotModule = {
  name: "publish",
  listeners: [onMessage] as Listener[],
};
