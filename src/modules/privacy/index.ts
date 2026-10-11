import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";

// Discord's Developer Terms have a bot make its privacy policy easy to reach from the bot itself.
const privacyCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("privacy")
    .setDescription("How this bot handles your data, and how to have it deleted.")
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    await interaction.reply({
      content: [
        "How this bot handles your data: <https://medius.k4tech.net/privacy>",
        "Open a ticket to have the bot's data on you deleted, or to report a problem with the bot.",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const privacyModule: BotModule = {
  name: "privacy",
  commands: [privacyCommand],
};
