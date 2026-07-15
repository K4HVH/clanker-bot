import {
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
} from "discord.js";
import type { AppContext } from "./context";
import type { ContextCommand, SlashCommand } from "./module";

type AnyCommandInteraction = ChatInputCommandInteraction | MessageContextMenuCommandInteraction;

export class CommandRouter {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly contextCommands = new Map<string, ContextCommand>();

  constructor(
    commands: SlashCommand[],
    contextCommands: ContextCommand[],
    private readonly ctx: AppContext,
  ) {
    for (const command of commands) this.commands.set(command.data.name, command);
    for (const command of contextCommands) this.contextCommands.set(command.data.name, command);
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.commands.get(interaction.commandName);
    if (!command) {
      this.ctx.logger.warn("unknown command", { commandName: interaction.commandName });
      return;
    }
    await this.run(interaction, () => command.execute(interaction, this.ctx));
  }

  async handleContext(interaction: MessageContextMenuCommandInteraction): Promise<void> {
    const command = this.contextCommands.get(interaction.commandName);
    if (!command) {
      this.ctx.logger.warn("unknown context command", { commandName: interaction.commandName });
      return;
    }
    await this.run(interaction, () => command.execute(interaction, this.ctx));
  }

  private async run(interaction: AnyCommandInteraction, exec: () => Promise<void>): Promise<void> {
    try {
      await exec();
    } catch (error) {
      this.ctx.logger.error("command failed", {
        commandName: interaction.commandName,
        error: error instanceof Error ? error.message : String(error),
      });
      const payload: InteractionReplyOptions = {
        content: "Something went wrong running that command.",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
}
