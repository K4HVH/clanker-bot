import { Client, Events, GatewayIntentBits } from "discord.js";
import { CommandRouter } from "./command-router";
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

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) void router.handle(interaction);
  });

  for (const module of modules) {
    for (const listener of module.listeners ?? []) {
      const invoke = (...args: unknown[]) =>
        (listener.handle as (ctx: AppContext, ...a: unknown[]) => void)(ctx, ...args);
      if (listener.once) client.once(listener.event, invoke);
      else client.on(listener.event, invoke);
    }
  }

  client.once(Events.ClientReady, (c) => {
    ctx.logger.info("logged in", { tag: c.user.tag });
  });

  return client;
}
