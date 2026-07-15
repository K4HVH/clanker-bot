import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  Events,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  OverwriteType,
  PermissionFlagsBits,
  type TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler, Listener } from "../../core/module";
import {
  beginClose,
  countOpenTicketsByUser,
  createTicket,
  firstOpenTicketByUser,
  getTicketByChannel,
  getTicketByNumber,
  listOpenTickets,
  setTicketTranscript,
  type TicketRecord,
  touchTicketActivity,
} from "../../db/tickets";
import { CONFIG_KEYS } from "../../lib/config";
import { buildTicketArchive } from "../../lib/ticket-transcript";

const ACCESS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

// In-memory: open ticket channels (gates the activity listener cheaply) and channels
// already warned about inactivity (avoids re-warning each scan). Rebuilt on startup.
export const openTicketChannels = new Set<string>();
const warnedTickets = new Set<string>();
// Users currently in the middle of opening a ticket, to serialize creation so the
// per-user open limit can't be beaten by submitting many modals at once.
const opening = new Set<string>();

const MAX_TRANSCRIPT_MESSAGES = 2000;

// Fetch the WHOLE ticket conversation OLDEST-first (paginating past Discord's 100/fetch cap).
// If it exceeds the safety ceiling we keep the OLDEST messages — the problem statement and how
// it unfolded — and report truncation, rather than silently dropping the start.
async function fetchAllMessages(
  channel: GuildTextBasedChannel,
): Promise<{ messages: Message[]; truncated: boolean }> {
  const out: Message[] = [];
  let after = channel.id; // snowflake floor: every message id in the channel is greater
  let truncated = false;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, after }).catch(() => null);
    if (!batch || batch.size === 0) break;
    // `after` responses aren't guaranteed ordered — sort oldest-first by snowflake.
    const arr = [...batch.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    out.push(...arr);
    const newest = arr[arr.length - 1];
    if (!newest) break;
    after = newest.id;
    if (out.length >= MAX_TRANSCRIPT_MESSAGES) {
      out.length = MAX_TRANSCRIPT_MESSAGES;
      truncated = true;
      break;
    }
    if (batch.size < 100) break;
  }
  return { messages: out, truncated };
}

function ticketButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Danger),
  );
}

async function isTicketStaff(guild: Guild, userId: string, ctx: AppContext): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const staffRoleId = ctx.config.get<string>(guild.id, CONFIG_KEYS.ticketStaffRoleId);
  return !!staffRoleId && member.roles.cache.has(staffRoleId);
}

// Decide whether a user may close a ticket. Staff always can; the opener can too, unless the
// guild has restricted closing to staff only. Returns a denial message, or null if allowed.
async function closeDenial(
  guild: Guild,
  userId: string,
  ticket: TicketRecord,
  ctx: AppContext,
): Promise<string | null> {
  if (await isTicketStaff(guild, userId, ctx)) return null;
  const staffOnly = ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.ticketStaffOnlyClose);
  if (!staffOnly && userId === ticket.openerId) return null;
  return staffOnly ? "Only staff can close tickets here." : "Only the opener or staff can close this.";
}

async function sendToModLog(
  ctx: AppContext,
  guild: Guild,
  payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] },
): Promise<void> {
  const id = ctx.config.get<string>(guild.id, CONFIG_KEYS.modLogChannelId);
  if (!id) return;
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (channel?.isTextBased()) await channel.send(payload).catch(() => {});
}

// Shared close: build the transcript+images zip, persist it, post to mod-log, DM the
// opener, then delete the channel. Used by the button, /ticket close, and auto-close.
async function closeTicketFlow(
  ctx: AppContext,
  guild: Guild,
  channel: GuildTextBasedChannel,
  ticket: TicketRecord,
  closedBy: string,
  reason: string | null,
): Promise<void> {
  // Claim the close atomically; if another trigger already won, do nothing.
  if (!beginClose(ctx.db, channel.id, closedBy, reason, Date.now())) return;
  openTicketChannels.delete(channel.id);
  warnedTickets.delete(channel.id);

  const withImages = ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.ticketArchiveImages);
  const { messages, truncated } = await fetchAllMessages(channel);
  const { text, zipBytes } = await buildTicketArchive(
    {
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      openerId: `<@${ticket.openerId}>`,
      closedBy: `<@${closedBy}>`,
      reason,
    },
    messages,
    { withImages, truncated },
  );
  setTicketTranscript(ctx.db, channel.id, text);

  const num = ticket.ticketNumber;
  const file = () =>
    zipBytes
      ? new AttachmentBuilder(Buffer.from(zipBytes), { name: `ticket-${num}.zip` })
      : new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `ticket-${num}.txt` });

  // DM the transcript to the opener first (if enabled) so the mod-log can report whether it
  // actually reached them — a closed-DM opener would otherwise fail completely silently.
  let dmStatus: string | null = null;
  if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.ticketDmTranscript)) {
    const opener = await guild.client.users.fetch(ticket.openerId).catch(() => null);
    const delivered = opener
      ? await opener
          .send({ content: `Your ticket **#${num}** in **${guild.name}** was closed.`, files: [file()] })
          .then(() => true)
          .catch(() => false)
      : false;
    dmStatus = delivered ? "✅ Sent to opener" : "⚠️ Couldn't DM the opener (DMs closed?)";
  }

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`Ticket #${num} closed`)
    .addFields(
      { name: "Opened by", value: `<@${ticket.openerId}>` },
      { name: "Closed by", value: `<@${closedBy}>` },
      { name: "Subject", value: ticket.subject },
    );
  if (reason) embed.addFields({ name: "Reason", value: reason });
  if (dmStatus) embed.addFields({ name: "Transcript DM", value: dmStatus });
  await sendToModLog(ctx, guild, { embeds: [embed], files: [file()] });

  await channel.delete(`Ticket #${num} closed`).catch(() => {});
}

// ── Subcommands ──────────────────────────────────────────────────────────────

const panelSub: Subcommand = {
  description: "Post the ticket panel in this channel.",
  permission: PermissionFlagsBits.ManageGuild,
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "Can't post here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Support")
      .setDescription(ctx.config.getEffective<string>(interaction.guildId, CONFIG_KEYS.ticketPanelText));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_open").setLabel("Open Ticket").setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};

// Helper for the in-ticket subcommands: resolve this channel's ticket or reply.
async function requireTicket(
  interaction: Parameters<Subcommand["execute"]>[0],
  ctx: AppContext,
): Promise<{ guild: Guild; channel: TextChannel; ticket: TicketRecord } | null> {
  const channel = interaction.channel;
  if (!interaction.guild || !channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "Run this inside a ticket channel.", flags: MessageFlags.Ephemeral });
    return null;
  }
  const ticket = getTicketByChannel(ctx.db, channel.id);
  if (!ticket || ticket.status === "closed") {
    await interaction.reply({ content: "This isn't an open ticket.", flags: MessageFlags.Ephemeral });
    return null;
  }
  return { guild: interaction.guild, channel, ticket };
}

const closeSub: Subcommand = {
  description: "Close the current ticket (opener or staff).",
  options: (s) => s.addStringOption((o) => o.setName("reason").setDescription("Why it's being closed")),
  async execute(interaction, ctx) {
    const t = await requireTicket(interaction, ctx);
    if (!t) return;
    const denial = await closeDenial(t.guild, interaction.user.id, t.ticket, ctx);
    if (denial) {
      await interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
      return;
    }
    const reason = interaction.options.getString("reason");
    await interaction.reply({ content: "Closing and archiving…", flags: MessageFlags.Ephemeral });
    await closeTicketFlow(ctx, t.guild, t.channel, t.ticket, interaction.user.id, reason);
  },
};

const addSub: Subcommand = {
  description: "Add a member to the current ticket.",
  options: (s) =>
    s.addUserOption((o) => o.setName("user").setDescription("Member to add").setRequired(true)),
  async execute(interaction, ctx) {
    const t = await requireTicket(interaction, ctx);
    if (!t) return;
    const isOpener = interaction.user.id === t.ticket.openerId;
    if (!isOpener && !(await isTicketStaff(t.guild, interaction.user.id, ctx))) {
      await interaction.reply({ content: "Only the opener or staff can add people.", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = interaction.options.getUser("user", true);
    await t.channel.permissionOverwrites.edit(target.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    await interaction.reply({ content: `Added <@${target.id}> to the ticket.` });
  },
};

const removeSub: Subcommand = {
  description: "Remove a member from the current ticket (staff).",
  options: (s) =>
    s.addUserOption((o) => o.setName("user").setDescription("Member to remove").setRequired(true)),
  async execute(interaction, ctx) {
    const t = await requireTicket(interaction, ctx);
    if (!t) return;
    if (!(await isTicketStaff(t.guild, interaction.user.id, ctx))) {
      await interaction.reply({ content: "Only staff can remove people.", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = interaction.options.getUser("user", true);
    if (target.id === t.ticket.openerId) {
      await interaction.reply({ content: "Can't remove the person who opened it.", flags: MessageFlags.Ephemeral });
      return;
    }
    await t.channel.permissionOverwrites.delete(target.id).catch(() => {});
    await interaction.reply({ content: `Removed <@${target.id}> from the ticket.` });
  },
};

// Retrieve a (usually closed) ticket's transcript by number — the channel is gone after
// close, so this is the way back to it. Text-only: posted images aren't retained past close.
const transcriptSub: Subcommand = {
  description: "Fetch a ticket's saved transcript by number (staff).",
  options: (s) =>
    s.addIntegerOption((o) =>
      o.setName("number").setDescription("The ticket number").setRequired(true).setMinValue(1),
    ),
  async execute(interaction, ctx) {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "Run this in the server.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await isTicketStaff(interaction.guild, interaction.user.id, ctx))) {
      await interaction.reply({ content: "Only staff can fetch transcripts.", flags: MessageFlags.Ephemeral });
      return;
    }
    const number = interaction.options.getInteger("number", true);
    const ticket = getTicketByNumber(ctx.db, interaction.guildId, number);
    if (!ticket) {
      await interaction.reply({ content: `No ticket #${number} found.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!ticket.transcript) {
      await interaction.reply({
        content:
          ticket.status === "open"
            ? `Ticket #${number} is still open — no transcript until it's closed.`
            : `Ticket #${number} has no saved transcript.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Transcript for ticket **#${number}** — text only (images aren't retained after close).`,
      files: [new AttachmentBuilder(Buffer.from(ticket.transcript, "utf8"), { name: `ticket-${number}.txt` })],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// ── Buttons ──────────────────────────────────────────────────────────────────

const openHandler: ComponentHandler = {
  customId: "ticket_open",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    if (!button.guild) return;
    const max = ctx.config.getEffective<number>(button.guild.id, CONFIG_KEYS.ticketMaxOpenPerUser);
    if (countOpenTicketsByUser(ctx.db, button.guild.id, button.user.id) >= max) {
      const first = firstOpenTicketByUser(ctx.db, button.guild.id, button.user.id);
      await button.reply({
        content: first
          ? `You already have an open ticket: <#${first.channelId}> (max ${max}).`
          : `You've reached the max of ${max} open tickets.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modal = new ModalBuilder().setCustomId("ticket_modal").setTitle("Open a ticket");
    const subject = new TextInputBuilder()
      .setCustomId("subject")
      .setLabel("What do you need help with?")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(300)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(subject));
    await button.showModal(modal);
  },
};

const modalHandler: ComponentHandler = {
  customId: "ticket_modal",
  type: "modal",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.guild) return;
    await modal.deferReply({ flags: MessageFlags.Ephemeral });

    // Serialize per-user so concurrent modal submits can't each pass the limit check
    // and mass-create channels before any row commits.
    const guildId = modal.guild.id;
    const lock = `${guildId}:${modal.user.id}`;
    if (opening.has(lock)) {
      await modal.editReply({ content: "You're already opening a ticket — hang on." });
      return;
    }
    opening.add(lock);
    try {
      const max = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.ticketMaxOpenPerUser);
      if (countOpenTicketsByUser(ctx.db, guildId, modal.user.id) >= max) {
        await modal.editReply({ content: `You've reached the max of ${max} open tickets.` });
        return;
      }

      const subject = modal.fields.getTextInputValue("subject");
      const categoryId = ctx.config.get<string>(guildId, CONFIG_KEYS.ticketCategoryId);
      const staffRoleId = ctx.config.get<string>(guildId, CONFIG_KEYS.ticketStaffRoleId);

      const overwrites: OverwriteResolvable[] = [
        { id: modal.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
        { id: modal.user.id, allow: ACCESS, type: OverwriteType.Member },
      ];
      if (staffRoleId) overwrites.push({ id: staffRoleId, allow: ACCESS, type: OverwriteType.Role });

      const channel = await modal.guild.channels.create({
        name: `ticket-${modal.user.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: categoryId ?? undefined,
        permissionOverwrites: overwrites,
      });

      let record: TicketRecord;
      try {
        record = createTicket(ctx.db, {
          guildId,
          channelId: channel.id,
          openerId: modal.user.id,
          subject,
        });
      } catch (error) {
        // The channel exists but the row didn't land — roll it back so we don't orphan a
        // ticket channel with no record (untracked, invisible to auto-close and the quota).
        await channel.delete("ticket row insert failed").catch(() => {});
        ctx.logger.error("ticket: failed to persist ticket row; rolled back channel", {
          guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        await modal.editReply({ content: "Something went wrong opening your ticket — please try again." });
        return;
      }
      openTicketChannels.add(channel.id);
      // Rename with the authoritative ticket number now that we have it, e.g. "10-kenny".
      await channel.setName(`${record.ticketNumber}-${modal.user.username}`.slice(0, 90)).catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle(`Ticket #${record.ticketNumber}`)
        .setDescription(subject)
        .addFields({ name: "Opened by", value: `<@${modal.user.id}>` });
      await channel.send({
        content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
        embeds: [embed],
        components: [ticketButtons()],
      });

      // Audit the open to the mod-log (previously only closes were logged there).
      await sendToModLog(ctx, modal.guild, {
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle(`Ticket #${record.ticketNumber} opened`)
            .addFields(
              { name: "Opened by", value: `<@${modal.user.id}>` },
              { name: "Channel", value: `<#${channel.id}>` },
              { name: "Subject", value: subject },
            )
            .setTimestamp(new Date()),
        ],
      });

      await modal.editReply({ content: `Ticket opened: <#${channel.id}>` });
    } finally {
      opening.delete(lock);
    }
  },
};

const closeHandler: ComponentHandler = {
  customId: "ticket_close",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    const t = await requireTicketButton(button, ctx);
    if (!t) return;
    const denial = await closeDenial(t.guild, button.user.id, t.ticket, ctx);
    if (denial) {
      await button.reply({ content: denial, flags: MessageFlags.Ephemeral });
      return;
    }
    // Skip the confirmation step if the guild has turned it off.
    if (!ctx.config.getEffective<boolean>(t.guild.id, CONFIG_KEYS.ticketCloseConfirm)) {
      await button.reply({ content: "Closing and archiving…", flags: MessageFlags.Ephemeral });
      await closeTicketFlow(ctx, t.guild, t.channel, t.ticket, button.user.id, null);
      return;
    }
    await button.reply({
      content: "Close this ticket? The channel will be archived and deleted.",
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("ticket_close_confirm").setLabel("Close").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("ticket_close_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  },
};

const closeCancelHandler: ComponentHandler = {
  customId: "ticket_close_cancel",
  type: "button",
  async handle(interaction) {
    const button = interaction as ButtonInteraction;
    await button.update({ content: "Cancelled.", components: [] });
  },
};

const closeConfirmHandler: ComponentHandler = {
  customId: "ticket_close_confirm",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    const t = await requireTicketButton(button, ctx);
    if (!t) return;
    await button.update({ content: "Closing and archiving…", components: [] });
    await closeTicketFlow(ctx, t.guild, t.channel, t.ticket, button.user.id, null);
  },
};

async function requireTicketButton(
  button: ButtonInteraction,
  ctx: AppContext,
): Promise<{ guild: Guild; channel: TextChannel; ticket: TicketRecord } | null> {
  const channel = button.channel;
  if (!button.guild || !channel || channel.type !== ChannelType.GuildText) return null;
  const ticket = getTicketByChannel(ctx.db, channel.id);
  if (!ticket || ticket.status === "closed") {
    await button.reply({ content: "This isn't an open ticket.", flags: MessageFlags.Ephemeral });
    return null;
  }
  return { guild: button.guild, channel, ticket };
}

// ── Listeners ────────────────────────────────────────────────────────────────

// A ticket channel is gone (deleted directly, or missing on startup) — close the row
// so it stops consuming the opener's open-quota and dangling as a dead link.
function reconcileGone(ctx: AppContext, channelId: string, botId: string, now: number): void {
  if (beginClose(ctx.db, channelId, botId, "channel deleted", now)) {
    setTicketTranscript(ctx.db, channelId, "(channel deleted)");
  }
  openTicketChannels.delete(channelId);
  warnedTickets.delete(channelId);
}

const onMessage: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    if (message.author.bot || !openTicketChannels.has(message.channelId)) return;
    touchTicketActivity(ctx.db, message.channelId, Date.now());
  },
};

// Deleting a ticket channel directly (instead of Close) must not orphan its row.
const onChannelDelete: Listener<Events.ChannelDelete> = {
  event: Events.ChannelDelete,
  async handle(ctx, channel) {
    const ticket = getTicketByChannel(ctx.db, channel.id);
    if (ticket && ticket.status !== "closed") {
      reconcileGone(ctx, channel.id, channel.client.user?.id ?? "system", Date.now());
    }
  },
};

const onReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle(ctx, client) {
    // Rebuild the open-channel set, reconciling any ticket whose channel vanished
    // while we were offline.
    for (const t of listOpenTickets(ctx.db)) {
      const guild =
        client.guilds.cache.get(t.guildId) ?? (await client.guilds.fetch(t.guildId).catch(() => null));
      const exists = guild ? await guild.channels.fetch(t.channelId).catch(() => null) : null;
      if (exists) openTicketChannels.add(t.channelId);
      else reconcileGone(ctx, t.channelId, client.user?.id ?? "system", Date.now());
    }
    const timer = setInterval(() => void scanInactivity(ctx, client, Date.now()), 5 * 60_000);
    timer.unref?.();
  },
};

// Warn once, then auto-close, open tickets idle past the configured window.
async function scanInactivity(ctx: AppContext, client: Client, now: number): Promise<void> {
  for (const ticket of listOpenTickets(ctx.db)) {
    const hours = ctx.config.getEffective<number>(ticket.guildId, CONFIG_KEYS.ticketInactivityHours);
    if (hours <= 0) {
      warnedTickets.delete(ticket.channelId);
      continue;
    }
    const idle = now - (ticket.lastActivityAt ?? ticket.createdAt);
    const warnAfter = hours * 3_600_000;
    const grace = Math.min(6 * 3_600_000, warnAfter * 0.5);
    const closeAfter = warnAfter + grace;
    if (idle < warnAfter) {
      warnedTickets.delete(ticket.channelId);
      continue;
    }

    const guild = await client.guilds.fetch(ticket.guildId).catch(() => null);
    const channel = guild
      ? await guild.channels.fetch(ticket.channelId).catch(() => null)
      : null;
    if (!guild || !channel || !channel.isTextBased()) {
      reconcileGone(ctx, ticket.channelId, client.user?.id ?? "system", now);
      continue;
    }

    if (idle >= closeAfter) {
      await closeTicketFlow(
        ctx,
        guild,
        channel,
        ticket,
        client.user?.id ?? "system",
        `Auto-closed after ${hours}h of inactivity`,
      );
    } else if (!warnedTickets.has(ticket.channelId)) {
      warnedTickets.add(ticket.channelId);
      const closeAt = Math.floor((now + (closeAfter - idle)) / 1000);
      await channel
        .send(`⏳ This ticket has gone quiet — it'll auto-close <t:${closeAt}:R> unless there's a reply.`)
        .catch(() => {});
    }
  }
}

export const ticketsModule: BotModule = {
  name: "tickets",
  commands: [
    featureCommand({
      name: "ticket",
      description: "Support tickets.",
      subcommands: {
        panel: panelSub,
        close: closeSub,
        add: addSub,
        remove: removeSub,
        transcript: transcriptSub,
      },
    }),
  ],
  listeners: [onMessage, onChannelDelete, onReady] as Listener[],
  components: [
    openHandler,
    modalHandler,
    closeHandler,
    closeConfirmHandler,
    closeCancelHandler,
  ],
};
