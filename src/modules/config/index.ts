import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";

const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("View or change bot configuration.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName("view").setDescription("Show the current configuration."))
  .addSubcommand((s) =>
    s
      .setName("log-channel")
      .setDescription("Set a log channel.")
      .addStringOption((o) =>
        o
          .setName("kind")
          .setDescription("Which log to set")
          .setRequired(true)
          .addChoices({ name: "mod", value: "mod" }, { name: "member", value: "member" }),
      )
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Target text channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("dm-on-action")
      .setDescription("Whether to DM users when they are actioned.")
      .addBooleanOption((o) =>
        o.setName("enabled").setDescription("Enable DMs on action").setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("toggle")
      .setDescription("Enable or disable a feature flag.")
      .addStringOption((o) =>
        o
          .setName("feature")
          .setDescription("Feature to toggle")
          .setRequired(true)
          .addChoices(
            { name: "automod-spam", value: "automod_spam" },
            { name: "automod-invites", value: "automod_invites" },
            { name: "automod-links", value: "automod_links" },
            { name: "auto-escalation", value: "auto_escalation" },
            { name: "raid-detection", value: "raid_detection" },
          ),
      )
      .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("verified-role")
      .setDescription("Set the role granted when a member passes verification.")
      .addRoleOption((o) => o.setName("role").setDescription("Verified role").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("min-account-age")
      .setDescription("Kick+flag accounts younger than this many days (0 = off).")
      .addIntegerOption((o) =>
        o
          .setName("days")
          .setDescription("Minimum age in days (0 disables)")
          .setMinValue(0)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("ticket-category")
      .setDescription("Category new ticket channels are created under.")
      .addChannelOption((o) =>
        o
          .setName("category")
          .setDescription("Category channel")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("ticket-staff")
      .setDescription("Role that can see and handle tickets.")
      .addRoleOption((o) => o.setName("role").setDescription("Staff role").setRequired(true)),
  );

const config: SlashCommand = {
  data,
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === "view") {
      const modCh = ctx.config.get<string>(guildId, CONFIG_KEYS.modLogChannelId);
      const memCh = ctx.config.get<string>(guildId, CONFIG_KEYS.memberLogChannelId);
      const dm = ctx.config.get<boolean>(guildId, CONFIG_KEYS.dmOnAction) ?? false;
      const embed = new EmbedBuilder().setTitle("Configuration").addFields(
        { name: "Mod log channel", value: modCh ? `<#${modCh}>` : "*(unset)*" },
        { name: "Member log channel", value: memCh ? `<#${memCh}>` : "*(unset)*" },
        { name: "DM on action", value: dm ? "enabled" : "disabled" },
        {
          name: "Automod",
          value: [
            `spam: ${ctx.config.get<boolean>(guildId, CONFIG_KEYS.automodSpam) ? "on" : "off"}`,
            `invites: ${ctx.config.get<boolean>(guildId, CONFIG_KEYS.automodInvites) ? "on" : "off"}`,
            `links: ${ctx.config.get<boolean>(guildId, CONFIG_KEYS.automodLinks) ? "on" : "off"}`,
          ].join(" · "),
        },
        {
          name: "Auto-escalation",
          value: ctx.config.get<boolean>(guildId, CONFIG_KEYS.autoEscalation) ? "on" : "off",
        },
        {
          name: "Verified role",
          value: (() => {
            const r = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
            return r ? `<@&${r}>` : "*(unset)*";
          })(),
        },
        {
          name: "Min account age",
          value: (() => {
            const d = ctx.config.get<number>(guildId, CONFIG_KEYS.minAccountAgeDays) ?? 0;
            return d > 0 ? `${d}d` : "off";
          })(),
        },
        {
          name: "Raid detection",
          value: ctx.config.get<boolean>(guildId, CONFIG_KEYS.raidDetection) ? "on" : "off",
        },
      );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "log-channel") {
      const kind = interaction.options.getString("kind", true);
      const channel = interaction.options.getChannel("channel", true);
      const key = kind === "mod" ? CONFIG_KEYS.modLogChannelId : CONFIG_KEYS.memberLogChannelId;
      ctx.config.set(guildId, key, channel.id);
      await interaction.reply({
        content: `Set the ${kind} log channel to <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "dm-on-action") {
      const enabled = interaction.options.getBoolean("enabled", true);
      ctx.config.set(guildId, CONFIG_KEYS.dmOnAction, enabled);
      await interaction.reply({
        content: `DM on action is now ${enabled ? "enabled" : "disabled"}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "toggle") {
      const feature = interaction.options.getString("feature", true);
      const enabled = interaction.options.getBoolean("enabled", true);
      ctx.config.set(guildId, feature, enabled);
      await interaction.reply({
        content: `\`${feature}\` is now ${enabled ? "enabled" : "disabled"}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "verified-role") {
      const role = interaction.options.getRole("role", true);
      ctx.config.set(guildId, CONFIG_KEYS.verifiedRoleId, role.id);
      await interaction.reply({
        content: `Verified role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "min-account-age") {
      const days = interaction.options.getInteger("days", true);
      ctx.config.set(guildId, CONFIG_KEYS.minAccountAgeDays, days);
      await interaction.reply({
        content: days > 0 ? `Account-age gate set to ${days}d.` : "Account-age gate disabled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "ticket-category") {
      const category = interaction.options.getChannel("category", true);
      ctx.config.set(guildId, CONFIG_KEYS.ticketCategoryId, category.id);
      await interaction.reply({ content: "Ticket category set.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "ticket-staff") {
      const role = interaction.options.getRole("role", true);
      ctx.config.set(guildId, CONFIG_KEYS.ticketStaffRoleId, role.id);
      await interaction.reply({
        content: `Ticket staff role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

export const configModule: BotModule = { name: "config", commands: [config] };
