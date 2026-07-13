import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { listCasesByUser } from "../../repositories/cases.repository";

export const historyCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show a user's moderation history.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const user = interaction.options.getUser("user", true);
    const records = listCasesByUser(ctx.db, interaction.guildId, user.id);
    if (records.length === 0) {
      await interaction.reply({
        content: `No cases for ${user.tag}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = records.map((r) => `**#${r.caseNumber}** \`${r.type}\` — ${r.reason}`);
    const embed = new EmbedBuilder()
      .setTitle(`History for ${user.tag}`)
      .setDescription(lines.join("\n"));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
