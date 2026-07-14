import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { listCasesByUser } from "../../db/cases";
import { CONFIG_KEYS } from "../../lib/config";
import { computeActiveScore } from "../../lib/infractions";

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
    const decayDays =
      ctx.config.get<number>(interaction.guildId, CONFIG_KEYS.strikeDecayDays) ?? 90;
    const score = computeActiveScore(records, Date.now(), decayDays);
    const lines = records.map((r) => `**#${r.caseNumber}** \`${r.type}\` — ${r.reason}`);
    const embed = new EmbedBuilder()
      .setTitle(`History for ${user.tag}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Active strike score: ${score} (last ${decayDays}d)` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
