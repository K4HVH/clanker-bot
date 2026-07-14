import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { scheduleAction } from "../../db/scheduled";
import { CONFIG_KEYS } from "../../lib/config";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../lib/duration";
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
    )
    .addStringOption((o) =>
      o.setName("duration").setDescription("Temp-ban length, e.g. 7d, 12h (omit for permanent)"),
    ),
  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (!guild) return;
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

    const durationText = interaction.options.getString("duration");
    let durationMs: number | null = null;
    if (durationText) {
      durationMs = parseDuration(durationText);
      if (durationMs === null || durationMs > MAX_TIMEOUT_MS) {
        await interaction.reply({
          content: "Invalid temp-ban duration. Use e.g. `12h`, `7d` (max 28d).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const target = await assertActionable(interaction, user.id, { requireMember: false });
    if (target === null) return;

    // DM before banning (best-effort) while we may still share a guild.
    const dmOn = ctx.config.get<boolean>(guild.id, CONFIG_KEYS.dmOnAction) ?? false;
    if (dmOn) {
      await user.send(`You were banned from **${guild.name}**. Reason: ${reason}`).catch(() => {});
    }

    await guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86_400 });

    const reasonWithDuration = durationMs
      ? `${reason} (temp-ban ${formatDuration(durationMs)})`
      : reason;
    if (durationMs) {
      scheduleAction(ctx.db, {
        guildId: guild.id,
        type: "unban",
        userId: user.id,
        reason: "Temp-ban expired",
        runAt: Date.now() + durationMs,
      });
    }
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "ban",
      reason: reasonWithDuration,
    });
  },
};
