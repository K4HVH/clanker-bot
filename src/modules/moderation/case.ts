import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { getCaseByNumber } from "../../db/cases";

export const caseCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("case")
    .setDescription("Look up a moderation case by number.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o.setName("number").setDescription("Case number").setRequired(true).setMinValue(1),
    ),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const number = interaction.options.getInteger("number", true);
    const record = getCaseByNumber(ctx.db, interaction.guildId, number);
    if (!record) {
      await interaction.reply({
        content: `No case #${number} found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(`Case #${record.caseNumber} · ${record.type.toUpperCase()}`)
      .addFields(
        { name: "User", value: `<@${record.userId}> (${record.userId})` },
        { name: "Moderator", value: `<@${record.moderatorId}>` },
        { name: "Reason", value: record.reason },
      )
      .setTimestamp(new Date(record.createdAt));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
