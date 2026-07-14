import type {
  ChatInputCommandInteraction,
  ClientEvents,
  MessageComponentInteraction,
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
  listeners?: Listener[];
  components?: ComponentHandler[];
}
