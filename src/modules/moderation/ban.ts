import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";
import { assertActionable, recordAndAnnounce } from "./shared";

export const banCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user (works even if they aren't in the server).")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName("delete_days")
        .setDescription("Delete this many days of their messages (0-7)")
        .setMinValue(0)
        .setMaxValue(7),
    ),
  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (!guild) return;
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

    const target = await assertActionable(interaction, user.id, { requireMember: false });
    if (target === null) return;

    // DM before banning (best-effort) while we may still share a guild.
    const dmOn = ctx.config.get<boolean>(guild.id, CONFIG_KEYS.dmOnAction) ?? false;
    if (dmOn) {
      await user.send(`You were banned from **${guild.name}**. Reason: ${reason}`).catch(() => {});
    }

    await guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86_400 });
    await recordAndAnnounce(interaction, ctx, { target: user, type: "ban", reason });
  },
};
