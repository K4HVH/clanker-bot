import {
  ActionRowBuilder,
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  type Guild,
  InteractionContextType,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  type MessageMentionOptions,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { BotModule, ComponentHandler, ContextCommand, SlashCommand } from "../../core/module";

// Build allowedMentions that mirror what the INVOKER could do by hand, so /say can't be used to
// mass-ping through the bot's elevated permissions. @users is always fine (anyone can ping a user).
// @everyone/@here and NON-mentionable roles require the invoker's own Mention Everyone permission;
// without it, only roles that are already mentionable (which anyone can ping) are allowed through.
function allowedMentionsFor(
  content: string,
  canPingEveryone: boolean | undefined,
  guild: Guild | null,
): MessageMentionOptions {
  if (canPingEveryone) return { parse: ["users", "roles", "everyone"] };
  const roleIds = [...content.matchAll(/<@&(\d+)>/g)]
    .map((m) => m[1])
    .filter((id): id is string => !!id && Boolean(guild?.roles.cache.get(id)?.mentionable));
  return { parse: ["users"], roles: [...new Set(roleIds)] };
}

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
    const sent = await channel
      .send({
        content,
        allowedMentions: allowedMentionsFor(
          content,
          interaction.memberPermissions?.has(PermissionFlagsBits.MentionEveryone),
          interaction.guild,
        ),
      })
      .catch(() => null);
    await interaction.reply({
      content: sent
        ? `✅ Sent to <#${channel.id}>.`
        : "Couldn't send there — check I have permission to post in that channel.",
      flags: MessageFlags.Ephemeral,
    });
  },
};

// Right-click a message → Apps → "Reply as bot" → a modal for the reply text.
const replyContext: ContextCommand = {
  data: new ContextMenuCommandBuilder()
    .setName("Reply as bot")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction: MessageContextMenuCommandInteraction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need the Manage Server permission.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`say_reply:${interaction.targetId}`) // carry the target message id
        .setTitle("Reply as bot")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("text")
              .setLabel("Your reply")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(2000),
          ),
        ),
    );
  },
};

const replyModalHandler: ComponentHandler = {
  customId: "say_reply",
  type: "modal",
  match: "prefix",
  async handle(interaction) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.inGuild() || !modal.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await modal.reply({ content: "You need the Manage Server permission.", flags: MessageFlags.Ephemeral });
      return;
    }
    const targetId = modal.customId.split(":")[1];
    const content = modal.fields.getTextInputValue("text").replace(/\\n/g, "\n").slice(0, 2000);
    const channel = modal.channel;
    if (!targetId || !channel || !("send" in channel)) {
      await modal.reply({ content: "Couldn't post the reply here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sent = await channel
      .send({
        content,
        reply: { messageReference: targetId, failIfNotExists: false },
        allowedMentions: {
          ...allowedMentionsFor(content, modal.memberPermissions?.has(PermissionFlagsBits.MentionEveryone), modal.guild),
          repliedUser: true,
        },
      })
      .catch(() => null);
    await modal.reply({
      content: sent ? "✅ Replied." : "Couldn't post the reply (message deleted, or I lack permission here).",
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const sayModule: BotModule = {
  name: "say",
  commands: [sayCommand],
  contextCommands: [replyContext],
  components: [replyModalHandler],
};
