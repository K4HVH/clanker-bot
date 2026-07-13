import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../util/duration";
import { assertActionable, recordAndAnnounce } from "./shared";

export const timeoutCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member for a duration (max 28d).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("e.g. 10m, 2h, 7d").setRequired(true),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser("user", true);
    const durationText = interaction.options.getString("duration", true);
    const reason = interaction.options.getString("reason", true);

    const ms = parseDuration(durationText);
    if (ms === null || ms > MAX_TIMEOUT_MS) {
      await interaction.reply({
        content: "Invalid duration. Use e.g. `10m`, `2h`, `7d` (max 28d).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = await assertActionable(interaction, user.id, { requireMember: true });
    if (member === null || member === "not-member") return;

    await member.timeout(ms, reason);
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "timeout",
      reason: `${reason} (${formatDuration(ms)})`,
      dmText: `You were timed out in **${interaction.guild?.name}** for ${formatDuration(ms)}. Reason: ${reason}`,
    });
  },
};
