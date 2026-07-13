import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { recordAndAnnounce } from "./shared";

export const unbanCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user by ID.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("User to unban").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (!guild) return;
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);

    const ban = await guild.bans.fetch(user.id).catch(() => null);
    if (!ban) {
      await interaction.reply({
        content: "That user isn't banned.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await guild.bans.remove(user.id, reason);
    await recordAndAnnounce(interaction, ctx, { target: user, type: "unban", reason });
  },
};
