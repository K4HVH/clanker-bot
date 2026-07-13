import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../../core/module";
import { recordAndAnnounce } from "./shared";

export const noteCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("note")
    .setDescription("Attach a private moderator note to a user.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Subject user").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Note text").setRequired(true)),
  async execute(interaction, ctx) {
    const target = interaction.options.getUser("user", true);
    const note = interaction.options.getString("note", true);
    await recordAndAnnounce(interaction, ctx, { target, type: "note", reason: note });
  },
};
