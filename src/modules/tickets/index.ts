import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { BotModule, ComponentHandler, SlashCommand } from "../../core/module";
import {
  closeTicket,
  createTicket,
  getTicketByChannel,
} from "../../db/tickets";
import { CONFIG_KEYS } from "../../lib/config";
import { logModAlert } from "../../lib/modlog";

function closeRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Danger),
  );
}

const ACCESS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

const ticketPanel: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Post the ticket panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "Can't post here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Support")
      .setDescription("Need help? Click **Open Ticket** to talk to the team privately.");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket_open")
        .setLabel("Open Ticket")
        .setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};

const openHandler: ComponentHandler = {
  customId: "ticket_open",
  type: "button",
  async handle(interaction) {
    const modal = new ModalBuilder().setCustomId("ticket_modal").setTitle("Open a ticket");
    const subject = new TextInputBuilder()
      .setCustomId("subject")
      .setLabel("What do you need help with?")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(300)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(subject));
    await (interaction as ButtonInteraction).showModal(modal);
  },
};

const modalHandler: ComponentHandler = {
  customId: "ticket_modal",
  type: "modal",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.guild) return;
    await modal.deferReply({ flags: MessageFlags.Ephemeral });

    const subject = modal.fields.getTextInputValue("subject");
    const categoryId = ctx.config.get<string>(modal.guild.id, CONFIG_KEYS.ticketCategoryId);
    const staffRoleId = ctx.config.get<string>(modal.guild.id, CONFIG_KEYS.ticketStaffRoleId);

    const overwrites: OverwriteResolvable[] = [
      {
        id: modal.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
        type: OverwriteType.Role,
      },
      { id: modal.user.id, allow: ACCESS, type: OverwriteType.Member },
    ];
    if (staffRoleId) overwrites.push({ id: staffRoleId, allow: ACCESS, type: OverwriteType.Role });

    const channel = await modal.guild.channels.create({
      name: `ticket-${modal.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: categoryId ?? undefined,
      permissionOverwrites: overwrites,
    });

    const record = createTicket(ctx.db, {
      guildId: modal.guild.id,
      channelId: channel.id,
      openerId: modal.user.id,
      subject,
    });

    const embed = new EmbedBuilder()
      .setTitle(`Ticket #${record.ticketNumber}`)
      .setDescription(subject)
      .addFields({ name: "Opened by", value: `<@${modal.user.id}>` });
    await channel.send({
      content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
      embeds: [embed],
      components: [closeRow()],
    });

    await modal.editReply({ content: `Ticket opened: <#${channel.id}>` });
  },
};

const closeHandler: ComponentHandler = {
  customId: "ticket_close",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    const channel = button.channel;
    if (!button.guild || !channel || channel.isDMBased() || !channel.isTextBased()) return;

    const ticket = getTicketByChannel(ctx.db, channel.id);
    if (!ticket || ticket.status === "closed") {
      await button.reply({ content: "This isn't an open ticket.", flags: MessageFlags.Ephemeral });
      return;
    }
    await button.reply({
      content: "Closing and saving transcript…",
      flags: MessageFlags.Ephemeral,
    });

    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const lines = fetched
      ? [...fetched.values()]
          .reverse()
          .map(
            (m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`,
          )
      : ["(transcript unavailable)"];
    const transcript = `Ticket #${ticket.ticketNumber} — ${ticket.subject}\n\n${lines.join("\n")}`;

    closeTicket(ctx.db, channel.id, transcript, Date.now());

    await logModAlert(
      ctx,
      button.guild,
      new EmbedBuilder()
        .setTitle(`Ticket #${ticket.ticketNumber} closed`)
        .addFields(
          { name: "Opened by", value: `<@${ticket.openerId}>` },
          { name: "Closed by", value: `<@${button.user.id}>` },
          { name: "Subject", value: ticket.subject },
        ),
    );

    const modLogId = ctx.config.get<string>(button.guild.id, CONFIG_KEYS.modLogChannelId);
    if (modLogId) {
      const modLog = await button.guild.channels.fetch(modLogId).catch(() => null);
      if (modLog?.isTextBased()) {
        const file = new AttachmentBuilder(Buffer.from(transcript, "utf8"), {
          name: `ticket-${ticket.ticketNumber}.txt`,
        });
        await modLog.send({ files: [file] }).catch(() => {});
      }
    }

    await channel.delete().catch(() => {});
  },
};

export const ticketsModule: BotModule = {
  name: "tickets",
  commands: [ticketPanel],
  components: [openHandler, modalHandler, closeHandler],
};
