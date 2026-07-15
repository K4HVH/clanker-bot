import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";

const sayCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("say")
    .setDescription("Post a message as the bot.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("message")
        .setDescription("What to say (use \\n for a line break)")
        .setRequired(true)
        .setMaxLength(2000),
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Where to post it (default: this channel)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  async execute(interaction) {
    if (!interaction.inGuild()) return;
    // setDefaultMemberPermissions only controls who SEES the command; re-check at runtime.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need the Manage Server permission.", flags: MessageFlags.Ephemeral });
      return;
    }

    const content = interaction.options.getString("message", true).replace(/\\n/g, "\n").slice(0, 2000);
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel || !("send" in channel)) {
      await interaction.reply({ content: "Can't post in that channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Post as the bot. Allow user/role pings, but never @everyone/@here — otherwise /say would
    // let a Manage-Server user mass-ping through the bot regardless of their own permission.
    const sent = await channel
      .send({ content, allowedMentions: { parse: ["users", "roles"] } })
      .catch(() => null);
    await interaction.reply({
      content: sent
        ? `✅ Sent to <#${channel.id}>.`
        : "Couldn't send there — check I have permission to post in that channel.",
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const sayModule: BotModule = {
  name: "say",
  commands: [sayCommand],
};
