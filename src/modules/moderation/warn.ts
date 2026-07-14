import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../../core/module";
import { applyEscalation } from "../../lib/escalation";
import { recordAndAnnounce } from "./shared";

export const warnCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Member to warn").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    await recordAndAnnounce(interaction, ctx, {
      target,
      type: "warn",
      reason,
      dmText: `You were warned in **${interaction.guild?.name}**. Reason: ${reason}`,
    });
    if (interaction.guild) await applyEscalation(ctx, interaction.guild, target.id);
  },
};
