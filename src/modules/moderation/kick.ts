import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../../core/module";
import { assertActionable, recordAndAnnounce } from "./shared";

export const kickCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const member = await assertActionable(interaction, user.id, { requireMember: true });
    if (member === null || member === "not-member") return;

    await member.kick(reason);
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "kick",
      reason,
      dmText: `You were kicked from **${interaction.guild?.name}**. Reason: ${reason}`,
    });
  },
};
