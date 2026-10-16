import { Client, Events, GatewayIntentBits, Partials, REST } from "discord.js";
import { CommandRouter } from "./command-router";
import { ComponentRouter } from "./component-router";
import type { AppContext } from "./context";
import type { BotModule } from "./module";
import { registerGuildCommands } from "./register-commands";

export type GuildRegistrar = (guildId: string) => Promise<void>;

export function createClient(
  modules: BotModule[],
  ctx: AppContext,
  register: GuildRegistrar = commandRegistrar(modules, ctx),
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Receive DM messages so verification can collect the code a joiner types
      // back in their DM. DM channels/messages arrive as partials.
      GatewayIntentBits.DirectMessages,
    ],
    // GuildMember is required for leaves to be seen at all: discord.js only emits
    // GuildMemberRemove/Update when it can resolve the member, and without this partial
    // that resolution is a plain member-cache lookup. The cache holds only members the bot
    // has actually seen (GUILD_CREATE sends ~50), so a lurker who joined before the last
    // restart would leave silently. Handlers for those events must tolerate a partial member.
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
  });

  const commands = modules.flatMap((m) => m.commands ?? []);
  const contextCommands = modules.flatMap((m) => m.contextCommands ?? []);
  const router = new CommandRouter(commands, contextCommands, ctx);
  const componentRouter = new ComponentRouter(
    modules.flatMap((m) => m.components ?? []),
    ctx,
  );

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) void router.handle(interaction);
    else if (interaction.isMessageContextMenuCommand()) void router.handleContext(interaction);
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
      // unhandled rejection (mirroring how ComponentRouter guards components).
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

  // Commands go to every guild: the ones the bot is in at startup, and any it joins later.
  const registerIn = (guildId: string) =>
    void register(guildId).catch((error: unknown) => {
      ctx.logger.error("command registration failed", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  client.on(Events.GuildCreate, (guild) => registerIn(guild.id));

  client.once(Events.ClientReady, (c) => {
    ctx.logger.info("logged in", { tag: c.user.tag });
    for (const guildId of c.guilds.cache.keys()) registerIn(guildId);
    // Fill the member cache once: GUILD_CREATE only ships a slice of the member list, and a
    // member who isn't cached leaves as a partial: the leave log then has no join date or
    // roles to report. Joins and member updates keep the cache current from here on.
    for (const guild of c.guilds.cache.values()) {
      void guild.members.fetch().catch((error: unknown) => {
        ctx.logger.warn("member cache warm-up failed: leaves may log without roles or tenure", {
          guildId: guild.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  return client;
}

function commandRegistrar(modules: BotModule[], ctx: AppContext): GuildRegistrar {
  const rest = new REST().setToken(ctx.env.token);
  return async (guildId) => {
    const count = await registerGuildCommands(rest, ctx.env.applicationId, guildId, modules);
    ctx.logger.info("registered guild commands", { count, guildId });
  };
}
