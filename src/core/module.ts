import type {
  ChatInputCommandInteraction,
  ClientEvents,
  ContextMenuCommandBuilder,
  MessageComponentInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { AppContext } from "./context";

// Structural type satisfied by SlashCommandBuilder and its subcommand/option variants.
export type CommandData = Pick<SlashCommandBuilder, "name" | "toJSON">;

export interface SlashCommand {
  data: CommandData;
  execute(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
}

// A right-click (message) context-menu command: "Apps → …" on a message.
export interface ContextCommand {
  data: Pick<ContextMenuCommandBuilder, "name" | "toJSON">;
  execute(interaction: MessageContextMenuCommandInteraction, ctx: AppContext): Promise<void>;
}

export interface Listener<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  handle(ctx: AppContext, ...args: ClientEvents[K]): Promise<void> | void;
}

export interface ComponentHandler {
  customId: string;
  type: "button" | "modal" | "select";
  // "exact" (default) matches customId exactly; "prefix" matches customId or `${customId}:...`.
  match?: "exact" | "prefix";
  handle(
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
    ctx: AppContext,
  ): Promise<void>;
}

export interface BotModule {
  name: string;
  commands?: SlashCommand[];
  contextCommands?: ContextCommand[];
  listeners?: Listener[];
  components?: ComponentHandler[];
  // Drop whatever the module holds in memory about one member (trackers, sessions, cooldowns), for
  // /mod forget. Database rows are deleted by the forget command itself.
  forget?(ctx: AppContext, guildId: string, userId: string): void;
}
