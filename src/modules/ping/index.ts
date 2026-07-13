import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";

const ping: SlashCommand = {
  data: new SlashCommandBuilder().setName("ping").setDescription("Check that the bot is alive."),
  async execute(interaction) {
    const latency = Math.round(interaction.client.ws.ping);
    await interaction.reply({
      content: `🏓 Pong! Gateway latency: ${latency}ms`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const pingModule: BotModule = { name: "ping", commands: [ping] };
