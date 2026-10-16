import { Events, type Guild } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { type Board, runComparison } from "../../lib/comparison-feed";
import { repeat } from "../../lib/repeat";

const EVERY_MS = 10 * 60_000;

async function keepGuild(ctx: AppContext, guild: Guild): Promise<void> {
  await runComparison(ctx, guild.id, async (id) => {
    const channel = await guild.channels.fetch(id).catch(() => null);
    return channel?.isTextBased() ? (channel as unknown as Board) : null;
  });
}

const onReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle(ctx, client) {
    const failed = (guildId: string | undefined) => (error: unknown) =>
      ctx.logger.error("comparison summary failed", { guildId, error: error instanceof Error ? error.message : String(error) });
    repeat(
      async () => {
        // Unattended work on a timer: a throw here has no interaction to fail.
        for (const guild of client.guilds.cache.values()) await keepGuild(ctx, guild).catch(failed(guild.id));
      },
      EVERY_MS,
      failed(undefined),
    );
  },
};

export const comparisonModule: BotModule = {
  name: "comparison",
  listeners: [onReady] as Listener[],
};
