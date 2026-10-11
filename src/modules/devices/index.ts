import { Events, type Guild } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { runFeed } from "../../lib/device-feed";

const EVERY_MS = 10 * 60_000;

type Postable = Parameters<typeof runFeed>[2] extends (id: string) => Promise<infer P> ? P : never;

// Runs `read` now and again `everyMs` after each run ends, so a slow run (a long first post) is never
// overlapped by the next.
export function repeat(read: () => Promise<void>, everyMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    await read();
    if (stopped) return;
    timer = setTimeout(() => void loop(), everyMs);
    timer.unref?.();
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function feedGuild(ctx: AppContext, guild: Guild): Promise<void> {
  await runFeed(ctx, guild.id, async (id) => {
    const channel = await guild.channels.fetch(id).catch(() => null);
    return channel?.isTextBased() ? (channel as unknown as Postable) : null;
  });
}

const onReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle(ctx, client) {
    repeat(async () => {
      // Unattended work on a timer: a throw here has no interaction to fail.
      for (const guild of client.guilds.cache.values()) {
        await feedGuild(ctx, guild).catch((error: unknown) =>
          ctx.logger.error("device feed failed", { guildId: guild.id, error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }, EVERY_MS);
  },
};

export const devicesModule: BotModule = {
  name: "devices",
  listeners: [onReady] as Listener[],
};
