import {
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  MessageFlags,
} from "discord.js";
import type { AppContext } from "./context";
import type { SlashCommand } from "./module";

export class CommandRouter {
  private readonly commands = new Map<string, SlashCommand>();

  constructor(
    commands: SlashCommand[],
    private readonly ctx: AppContext,
  ) {
    for (const command of commands) this.commands.set(command.data.name, command);
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.commands.get(interaction.commandName);
    if (!command) {
      this.ctx.logger.warn("unknown command", { commandName: interaction.commandName });
      return;
    }
    try {
      await command.execute(interaction, this.ctx);
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
