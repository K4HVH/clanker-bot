import { Client, Events, GatewayIntentBits } from "discord.js";
import { CommandRouter } from "./command-router";
import { ComponentRouter } from "./component-router";
import type { AppContext } from "./context";
import type { BotModule } from "./module";

export function createClient(modules: BotModule[], ctx: AppContext): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const commands = modules.flatMap((m) => m.commands ?? []);
  const router = new CommandRouter(commands, ctx);
  const componentRouter = new ComponentRouter(
    modules.flatMap((m) => m.components ?? []),
    ctx,
  );

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) void router.handle(interaction);
    else if (
      interaction.isButton() ||
      interaction.isModalSubmit() ||
      interaction.isAnySelectMenu()
    )
      void componentRouter.handle(interaction);
  });

  for (const module of modules) {
    for (const listener of module.listeners ?? []) {
      // Wrap every listener in an error boundary so a throw/rejection in one
      // handler (e.g. a failed captcha render on join) is logged, not an
      // unhandled rejection — mirroring how ComponentRouter guards components.
      const handle = listener.handle as (
        ctx: AppContext,
        ...a: unknown[]
      ) => Promise<void> | void;
      const invoke = async (...args: unknown[]) => {
        try {
          await handle(ctx, ...args);
        } catch (error) {
          ctx.logger.error("listener failed", {
            event: String(listener.event),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      if (listener.once) client.once(listener.event, invoke);
      else client.on(listener.event, invoke);
    }
  }

  client.once(Events.ClientReady, (c) => {
    ctx.logger.info("logged in", { tag: c.user.tag });
  });

  return client;
}
