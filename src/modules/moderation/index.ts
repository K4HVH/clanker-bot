import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { BotModule } from "../../core/module";
import { getCaseByNumber, listCasesByUser } from "../../db/cases";
import { scheduleAction } from "../../db/scheduled";
import { CONFIG_KEYS } from "../../lib/config";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../lib/duration";
import { applyEscalation } from "../../lib/escalation";
import { computeActiveScore, strikeWeightsFrom } from "../../lib/infractions";
import { assertActionable, recordAndAnnounce } from "./shared";

const warnSub: Subcommand = {
  description: "Warn a member.",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s
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

const noteSub: Subcommand = {
  description: "Attach a private moderator note to a user.",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s
      .addUserOption((o) => o.setName("user").setDescription("Subject user").setRequired(true))
      .addStringOption((o) => o.setName("note").setDescription("Note text").setRequired(true)),
  async execute(interaction, ctx) {
    const target = interaction.options.getUser("user", true);
    const note = interaction.options.getString("note", true);
    await recordAndAnnounce(interaction, ctx, { target, type: "note", reason: note });
  },
};

const timeoutSub: Subcommand = {
  description: "Timeout a member for a duration (max 28d).",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s
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

const kickSub: Subcommand = {
  description: "Kick a member.",
  permission: PermissionFlagsBits.KickMembers,
  options: (s) =>
    s
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

const banSub: Subcommand = {
  description: "Ban a user (works even if they aren't in the server).",
  permission: PermissionFlagsBits.BanMembers,
  options: (s) =>
    s
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

const unbanSub: Subcommand = {
  description: "Unban a user by ID.",
  permission: PermissionFlagsBits.BanMembers,
  options: (s) =>
    s
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

const caseSub: Subcommand = {
  description: "Look up a moderation case by number.",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s.addIntegerOption((o) =>
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

const historySub: Subcommand = {
  description: "Show a user's moderation history.",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s.addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
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
    const decayDays = ctx.config.getEffective<number>(
      interaction.guildId,
      CONFIG_KEYS.strikeDecayDays,
    );
    const score = computeActiveScore(
      records,
      Date.now(),
      decayDays,
      strikeWeightsFrom(ctx.config, interaction.guildId),
    );
    const lines = records.map((r) => `**#${r.caseNumber}** \`${r.type}\` — ${r.reason}`);
    const embed = new EmbedBuilder()
      .setTitle(`History for ${user.tag}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Active strike score: ${score} (last ${decayDays}d)` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export const moderationModule: BotModule = {
  name: "moderation",
  commands: [
    featureCommand({
      name: "mod",
      description: "Moderation actions.",
      // Baseline visibility; each verb runtime-checks its own permission above, and
      // admins can fine-tune per-subcommand access in Discord's Integrations UI.
      defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
      subcommands: {
        warn: warnSub,
        note: noteSub,
        timeout: timeoutSub,
        kick: kickSub,
        ban: banSub,
        unban: unbanSub,
        case: caseSub,
        history: historySub,
      },
    }),
  ],
};
