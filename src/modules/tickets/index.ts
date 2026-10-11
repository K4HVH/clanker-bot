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
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  OverwriteType,
  PermissionFlagsBits,
  type TextChannel,
  type User,
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
  setTicketHold,
  setTicketTranscript,
  type TicketRecord,
  touchTicketActivity,
} from "../../db/tickets";
import { clearCheckResult, recordCheckPass } from "../../db/ticket-check";
import { CONFIG_KEYS } from "../../lib/config";
import { userValue } from "../../lib/modlog";
import { buildTicketArchive } from "../../lib/ticket-transcript";
import {
  checkComponents,
  clearCheckSession,
  gateTicket,
  readPolicy,
  sweepSessions,
  takePassNote,
} from "./check";
import {
  isTicketStaff,
  minSubjectWords,
  sendToModLog,
  subjectDenial,
  subjectModal,
  SUBJECT_MAX,
} from "./shared";

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

// Plain-text form, for the transcript file: markdown and mentions are both dead weight there.
function nameAndId(id: string, name?: string | null): string {
  return name ? `${name} (${id})` : id;
}

// A subject is optional, so it's stored as "" when skipped. Everywhere one is DISPLAYED
// goes through here: embed fields and descriptions reject empty strings outright, and the
// placeholder stays a display concern rather than baked into rows we can't reword later.
function subjectLine(subject: string): string {
  return subject.trim() || "(no subject)";
}

// Fetch the WHOLE ticket conversation OLDEST-first (paginating past Discord's 100/fetch cap).
// If it exceeds the safety ceiling we keep the OLDEST messages (the problem statement and how
// it unfolded) and report truncation, rather than silently dropping the start.
async function fetchAllMessages(
  channel: GuildTextBasedChannel,
): Promise<{ messages: Message[]; truncated: boolean }> {
  const out: Message[] = [];
  let after = channel.id; // snowflake floor: every message id in the channel is greater
  let truncated = false;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, after }).catch(() => null);
    if (!batch || batch.size === 0) break;
    // `after` responses aren't guaranteed ordered: sort oldest-first by snowflake.
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

// Shared close: build the transcript+images zip, persist it, post to mod-log, DM the
// opener, then delete the channel. Used by the button, /ticket close, and auto-close.
async function closeTicketFlow(
  ctx: AppContext,
  guild: Guild,
  channel: GuildTextBasedChannel,
  ticket: TicketRecord,
  closedBy: string,
  reason: string | null,
  opts: { unlessHeld?: boolean } = {},
): Promise<void> {
  // Claim the close atomically; if another trigger already won (or the auto-close lost
  // to a hold applied since the scan read the row), do nothing.
  if (!beginClose(ctx.db, channel.id, closedBy, reason, Date.now(), opts)) return;
  openTicketChannels.delete(channel.id);
  warnedTickets.delete(channel.id);

  // Who this was, by name. The transcript is a plain .txt, where a mention is just raw
  // "<@id>" text, and in an embed it only renders for a reader whose client has them cached.
  const [opener, closer] = await Promise.all([
    guild.client.users.fetch(ticket.openerId).catch(() => null),
    guild.client.users.fetch(closedBy).catch(() => null),
  ]);
  const withImages = ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.ticketArchiveImages);
  const { messages, truncated } = await fetchAllMessages(channel);
  const { text, zipBytes } = await buildTicketArchive(
    {
      ticketNumber: ticket.ticketNumber,
      subject: subjectLine(ticket.subject),
      openerId: nameAndId(ticket.openerId, opener?.username),
      closedBy: nameAndId(closedBy, closer?.username),
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
  // actually reached them: a closed-DM opener would otherwise fail completely silently.
  let dmStatus: string | null = null;
  if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.ticketDmTranscript)) {
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
      { name: "Opened by", value: userValue(ticket.openerId, opener?.username) },
      { name: "Closed by", value: userValue(closedBy, closer?.username) },
      { name: "Subject", value: subjectLine(ticket.subject) },
    );
  if (reason) embed.addFields({ name: "Reason", value: reason });
  if (dmStatus) embed.addFields({ name: "Transcript DM", value: dmStatus });
  await sendToModLog(ctx, guild, { embeds: [embed], files: [file()] });

  await channel.delete(`Ticket #${num} closed`).catch(() => {});
}

// Close a ticket by deleting its channel, with no transcript and no mod-log post: for /mod forget,
// whose request ticket would otherwise be archived with the data it asked to have deleted.
export async function closeTicketQuietly(channel: { id: string; delete(reason?: string): Promise<unknown> }): Promise<void> {
  openTicketChannels.delete(channel.id);
  warnedTickets.delete(channel.id);
  await channel.delete("Closed at the member's request").catch(() => {});
}

// Whether `openerId` is out of ticket slots, as a message to show whoever asked. `via` is
// set when staff are opening on that member's behalf, so the wording addresses them about
// someone else. Shared by the panel button's pre-check and the open flow itself.
function quotaDenial(
  ctx: AppContext,
  guildId: string,
  openerId: string,
  via: boolean,
): string | null {
  const max = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.ticketMaxOpenPerUser);
  const open = countOpenTicketsByUser(ctx.db, guildId, openerId);
  if (open < max) return null;
  const who = via ? `<@${openerId}> already has` : "You already have";
  const what = open === 1 ? "an open ticket" : `${open} open tickets`;
  const first = firstOpenTicketByUser(ctx.db, guildId, openerId);
  return first
    ? `${who} ${what} (max ${max}), starting with <#${first.channelId}>.`
    : `${who} ${what} (max ${max}).`;
}

// Shared open: enforce the per-user quota, create the private channel, persist the row
// (rolling the channel back if that fails), post the opening message and audit it to the
// mod-log. Used by the panel modal and /ticket open. `via` is set when staff opened this
// on someone else's behalf: the ticket belongs to `opener` either way, and `via` only
// records who pressed the button. Returns the channel id, or a message to show the caller.
async function openTicketFlow(
  ctx: AppContext,
  guild: Guild,
  opener: User,
  subject: string,
  via: User | null,
): Promise<{ ok: true; channelId: string } | { ok: false; message: string }> {
  const guildId = guild.id;
  // Serialize per opener so concurrent submits can't each pass the limit check and
  // mass-create channels before any row commits.
  const lock = `${guildId}:${opener.id}`;
  if (opening.has(lock)) {
    return {
      ok: false,
      message: via
        ? `A ticket for <@${opener.id}> is already being opened. Hang on.`
        : "You're already opening a ticket. Hang on.",
    };
  }
  opening.add(lock);
  try {
    const denial = quotaDenial(ctx, guildId, opener.id, via !== null);
    if (denial) return { ok: false, message: denial };

    const categoryId = ctx.config.get<string>(guildId, CONFIG_KEYS.ticketCategoryId);
    const staffRoleId = ctx.config.get<string>(guildId, CONFIG_KEYS.ticketStaffRoleId);

    const overwrites: OverwriteResolvable[] = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
      { id: opener.id, allow: ACCESS, type: OverwriteType.Member },
    ];
    if (staffRoleId) overwrites.push({ id: staffRoleId, allow: ACCESS, type: OverwriteType.Role });
    // Whoever opened this for someone else may not hold the staff role (a ManageGuild admin,
    // say), so grant them access explicitly rather than create a channel they can't see.
    if (via) overwrites.push({ id: via.id, allow: ACCESS, type: OverwriteType.Member });
    // And us: the @everyone deny above applies to the bot too, and a channel overwrite beats
    // a guild-level permission, so without this we couldn't post in the ticket we just made
    // unless we happen to be running as Administrator.
    const meId = guild.members.me?.id ?? guild.client.user?.id;
    if (meId) overwrites.push({ id: meId, allow: ACCESS, type: OverwriteType.Member });

    // Creation fails for reasons an admin can fix (no Manage Channels, a deleted ticket
    // category, the 500-channel guild cap), so say so instead of letting it throw: the
    // panel-modal caller has already deferred, and its router won't answer a modal submit,
    // which would leave the member on a "thinking…" spinner that never resolves.
    const channel = await guild.channels
      .create({
        name: `ticket-${opener.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        parent: categoryId ?? undefined,
        permissionOverwrites: overwrites,
      })
      .catch((error: unknown) => {
        ctx.logger.error("ticket: could not create the ticket channel", {
          guildId,
          categoryId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    if (!channel) {
      return {
        ok: false,
        message:
          "I couldn't create the ticket channel. Check that I have **Manage Channels** and that the configured ticket category still exists.",
      };
    }

    let record: TicketRecord;
    try {
      record = createTicket(ctx.db, { guildId, channelId: channel.id, openerId: opener.id, subject });
    } catch (error) {
      // The channel exists but the row didn't land: roll it back so we don't orphan a
      // ticket channel with no record (untracked, invisible to auto-close and the quota).
      await channel.delete("ticket row insert failed").catch(() => {});
      ctx.logger.error("ticket: failed to persist ticket row; rolled back channel", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, message: "Something went wrong opening the ticket. Please try again." };
    }
    openTicketChannels.add(channel.id);
    // Rename with the authoritative ticket number now that we have it, e.g. "10-kenny".
    await channel.setName(`${record.ticketNumber}-${opener.username}`.slice(0, 90)).catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle(`Ticket #${record.ticketNumber}`)
      .setDescription(subjectLine(subject))
      .addFields({ name: "Opened by", value: userValue(opener.id, opener.username) });
    // Ping the opener too when someone else opened it for them: it's their ticket, and
    // otherwise the first they'd know of it is stumbling into the channel.
    if (via) embed.addFields({ name: "Opened via", value: userValue(via.id, via.username) });
    const mentions = [staffRoleId ? `<@&${staffRoleId}>` : null, via ? `<@${opener.id}>` : null]
      .filter((m): m is string => m !== null)
      .join(" ");
    // Past this point the row is committed and the ticket exists, so a failure here must
    // not be reported as "opening failed": the member would retry and burn another slot of
    // their quota on a ticket that's already open. Log it and hand back the channel.
    await channel
      .send({ content: mentions || undefined, embeds: [embed], components: [ticketButtons()] })
      .catch((error: unknown) => {
        ctx.logger.error("ticket: opened, but couldn't post the opening message", {
          guildId,
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    // Audit the open to the mod-log (previously only closes were logged there).
    const logEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`Ticket #${record.ticketNumber} opened`)
      .addFields({ name: "Opened by", value: userValue(opener.id, opener.username) });
    if (via) logEmbed.addFields({ name: "Opened via", value: userValue(via.id, via.username) });
    logEmbed.addFields(
      // Mention (a live link while open) + the name, so the entry still reads after the
      // channel is deleted on close (the mention would become "#unknown").
      { name: "Channel", value: `<#${channel.id}> (\`${channel.name}\`)` },
      { name: "Subject", value: subjectLine(subject) },
    );
    // How they did on the check, when one was sat for this ticket. This is what tells
    // the owner whether the bar is set right, rather than only seeing who failed.
    // Only for a ticket they opened themselves: staff opening one with `for:` skips the
    // check entirely, so attaching the member's pass to it would report a check that had
    // nothing to do with this ticket, and consume the note their own ticket needed.
    const check = via ? undefined : takePassNote(guildId, opener.id);
    if (check) {
      logEmbed.addFields({
        name: "Check",
        value: `${check.correct}/${check.total} in ${Math.round(check.elapsedMs / 1000)}s`,
      });
    }
    logEmbed.setTimestamp(new Date());
    await sendToModLog(ctx, guild, { embeds: [logEmbed] });

    return { ok: true, channelId: channel.id };
  } finally {
    opening.delete(lock);
  }
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

// Open a ticket without the panel button. Staff can open one on someone else's behalf
// with `for`: the ticket is then THEIRS (their quota, their name on the channel, theirs
// to close) and the runner is recorded as who opened it.
const openSub: Subcommand = {
  description: "Open a support ticket.",
  options: (s) =>
    s
      .addStringOption((o) =>
        o.setName("subject").setDescription("What you need help with").setMaxLength(SUBJECT_MAX),
      )
      .addUserOption((o) =>
        o.setName("for").setDescription("Open it on this member's behalf (staff only)"),
      ),
  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: "Run this in the server.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Tickets are opt-in per guild: the panel button only exists once an admin posts one,
    // so without a gate of its own this command would be live in every guild the bot joins,
    // including ones that never configured tickets (where it creates a root-level channel
    // nobody but the opener can see, and no staff role to answer it).
    const configured =
      !!ctx.config.get<string>(guild.id, CONFIG_KEYS.ticketCategoryId) ||
      !!ctx.config.get<string>(guild.id, CONFIG_KEYS.ticketStaffRoleId);
    if (!configured) {
      await interaction.reply({
        content: "Tickets aren't set up in this server yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = interaction.options.getUser("for");
    let opener = interaction.user;
    let via: User | null = null;
    if (target && target.id !== interaction.user.id) {
      if (!(await isTicketStaff(guild, interaction.user.id, ctx))) {
        await interaction.reply({
          content: "Only staff can open tickets for someone else.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (target.bot) {
        await interaction.reply({ content: "Bots don't get tickets.", flags: MessageFlags.Ephemeral });
        return;
      }
      // Must be a member: a non-member can't be given channel access, and the ticket
      // would sit there with nobody able to answer it.
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (!member) {
        await interaction.reply({
          content: `<@${target.id}> isn't in this server.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      opener = target;
      via = interaction.user;
    }

    const subject = interaction.options.getString("subject") ?? "";
    // Staff opening on someone's behalf have already decided that person needs a ticket,
    // so `via` skips the check entirely.
    if (!via) {
      // Cheapest refusal first: being told you are at your limit after writing a
      // description, or after answering three questions, is what makes someone give up on
      // the whole thing.
      const denial = quotaDenial(ctx, guild.id, opener.id, false);
      if (denial) {
        await interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
        return;
      }
      // The modal cannot enforce anything here: this subject arrived as a command option.
      // Checked before the questions, so a two-word one is refused straight away rather
      // than after a quiz that was never going to end in a ticket.
      const short = subjectDenial(subject, minSubjectWords(ctx, guild.id));
      if (short) {
        await interaction.reply({ content: short, flags: MessageFlags.Ephemeral });
        return;
      }
      const gate = await gateTicket(ctx, guild, opener, { kind: "command", subject });
      if (gate.kind === "stop") {
        await interaction.reply(gate.reply);
        return;
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await openTicketFlow(ctx, guild, opener, subject, via);
    if (!result.ok) {
      await interaction.editReply({ content: result.message });
      return;
    }
    await interaction.editReply({
      content: via
        ? `Ticket opened for <@${opener.id}>: <#${result.channelId}>`
        : `Ticket opened: <#${result.channelId}>`,
    });
  },
};

// Exempt one ticket from the inactivity auto-close, so a slow-burning one (waiting on a
// part, a repro, a vendor) doesn't need keep-alive chatter to survive.
const holdSub: Subcommand = {
  description: "Hold this ticket open, exempt from inactivity auto-close (staff).",
  options: (s) =>
    s.addBooleanOption((o) =>
      o.setName("on").setDescription("On to hold, off to release. Omit to toggle."),
    ),
  async execute(interaction, ctx) {
    const t = await requireTicket(interaction, ctx);
    if (!t) return;
    if (!(await isTicketStaff(t.guild, interaction.user.id, ctx))) {
      await interaction.reply({
        content: "Only staff can hold tickets open.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const hold = interaction.options.getBoolean("on") ?? !t.ticket.autoCloseHold;
    // Only open tickets can be held, and one can close between requireTicket and here.
    if (!setTicketHold(ctx.db, t.channel.id, hold)) {
      await interaction.reply({
        content: "This ticket just closed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Releasing restarts the idle clock: the held stretch shouldn't count against the
    // ticket, or a week-long hold would auto-close it the moment it's let go.
    if (hold) warnedTickets.delete(t.channel.id);
    else touchTicketActivity(ctx.db, t.channel.id, Date.now());

    const hours = ctx.config.getEffective<number>(t.guild.id, CONFIG_KEYS.ticketInactivityHours);
    const by = `<@${interaction.user.id}>`;
    const message = hold
      ? hours > 0
        ? `🔒 Held open by ${by}: inactivity auto-close is paused for this ticket.`
        : `🔒 Held open by ${by}: auto-close is off server-wide anyway, so this only matters if it's turned on later.`
      : hours > 0
        ? `⏱️ Hold released by ${by}: this ticket auto-closes after ${hours}h idle again, counting from now.`
        : `⏱️ Hold released by ${by}: auto-close is off server-wide, so it stays open regardless.`;
    await interaction.reply({ content: message });
  },
};

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

// Retrieve a (usually closed) ticket's transcript by number: the channel is gone after
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
            ? `Ticket #${number} is still open: no transcript until it's closed.`
            : `Ticket #${number} has no saved transcript.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Transcript for ticket **#${number}**: text only (images aren't retained after close).`,
      files: [new AttachmentBuilder(Buffer.from(ticket.transcript, "utf8"), { name: `ticket-${number}.txt` })],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// Staff override for the intelligence check. Without it, a gate that bounces someone it
// shouldn't leaves no recourse short of switching the feature off for everyone.
const checkSub: Subcommand = {
  description: "Reset or grant a member's ticket check (staff).",
  options: (s) =>
    s
      .addUserOption((o) => o.setName("user").setDescription("Member to act on").setRequired(true))
      .addBooleanOption((o) =>
        o.setName("pass").setDescription("Mark them as passed instead of clearing their state"),
      ),
  async execute(interaction, ctx) {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: "Run this in the server.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await isTicketStaff(guild, interaction.user.id, ctx))) {
      await interaction.reply({
        content: "Only staff can change someone's check.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const target = interaction.options.getUser("user", true);
    const pass = interaction.options.getBoolean("pass") ?? false;
    const policy = readPolicy(ctx, guild.id);
    if (pass) recordCheckPass(ctx.db, guild.id, target.id, Date.now());
    else clearCheckResult(ctx.db, guild.id, target.id);
    // Either way, whatever they have open stops being theirs to finish: a cleared member
    // sits a fresh check, and a passed one is not left with a quiz the sweep would later
    // charge them a failure for.
    clearCheckSession(guild.id, target.id);

    // Say so when the setting makes the action pointless, rather than reporting success
    // for something that will have no effect.
    const off = policy.enabled ? "" : " The check is switched off in this server right now.";
    const message = pass
      ? policy.passDays > 0
        ? `<@${target.id}> is marked as passed: they won't be asked again for ${policy.passDays} days.${off}`
        : `<@${target.id}> is marked as passed, but the pass window is 0 days, so they'll still be asked on their next ticket.${off}`
      : `Cleared <@${target.id}>'s check: any cooldown is lifted, whatever they had open is closed, and they'll sit a fresh one next time.${off}`;
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  },
};

// ── Buttons ──────────────────────────────────────────────────────────────────

const openHandler: ComponentHandler = {
  customId: "ticket_open",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    if (!button.guild) return;
    // Pre-check so someone at their limit gets told before filling in a modal. The flow
    // re-checks under its lock: this is a courtesy, not the enforcement.
    const denial = quotaDenial(ctx, button.guild.id, button.user.id, false);
    if (denial) {
      await button.reply({ content: denial, flags: MessageFlags.Ephemeral });
      return;
    }
    // Quota first, then the check: nobody should answer questions only to be told they
    // already have too many tickets open.
    const gate = await gateTicket(ctx, button.guild, button.user, { kind: "panel" });
    if (gate.kind === "stop") {
      await button.reply(gate.reply);
      return;
    }
    await button.showModal(subjectModal(false, minSubjectWords(ctx, button.guild.id)));
  },
};

const modalHandler: ComponentHandler = {
  customId: "ticket_modal",
  type: "modal",
  // "ticket_modal" from the panel button, "ticket_modal:check" off a passed check.
  match: "prefix",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.guild) return;
    // Off a passed check this modal belongs to the ephemeral question message, so update
    // it in place instead of leaving the answered question on screen under a second
    // reply. Off the panel button it belongs to the PUBLIC panel message, which must be
    // left alone: see subjectModal() for why the source message can't tell us which.
    const fromCheck = modal.customId.endsWith(":check");
    if (fromCheck && modal.isFromMessage()) await modal.deferUpdate();
    else await modal.deferReply({ flags: MessageFlags.Ephemeral });
    // The subject input is optional, so Discord may send it back empty (or, in principle,
    // not at all: getTextInputValue throws on a missing field). Both mean "no subject".
    const subject = modal.fields.fields.has("subject")
      ? modal.fields.getTextInputValue("subject")
      : "";
    // Discord's own minimum is a character count, so a long enough string of nothing much
    // still reaches us. This is where the words are actually counted.
    const short = subjectDenial(subject, minSubjectWords(ctx, modal.guild.id));
    if (short) {
      await modal.editReply({ content: short, embeds: [], components: [] });
      return;
    }
    const result = await openTicketFlow(ctx, modal.guild, modal.user, subject, null);
    // Clearing both is what removes the answered question when this came from a check.
    await modal.editReply({
      content: result.ok ? `Ticket opened: <#${result.channelId}>` : result.message,
      embeds: [],
      components: [],
    });
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

// A ticket channel is gone (deleted directly, or missing on startup), close the row
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
    const timer = setInterval(() => {
      // Unattended work on a timer: a throw here has no interaction to fail and would
      // take the process down instead.
      try {
        sweepSessions(ctx, Date.now());
      } catch (error) {
        ctx.logger.error("ticket: sweeping abandoned checks failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      void scanInactivity(ctx, client, Date.now());
    }, 5 * 60_000);
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

    // Held open by staff (/ticket hold): no warning, no close, however long it sits. This
    // sits BELOW the channel-existence check on purpose: a held ticket whose channel was
    // deleted must still be reconciled, or its row stays open forever and permanently eats
    // a slot of the opener's quota.
    if (ticket.autoCloseHold) {
      warnedTickets.delete(ticket.channelId);
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
        // Staff can hold this ticket while we're archiving an earlier one in the same pass.
        { unlessHeld: true },
      );
    } else if (!warnedTickets.has(ticket.channelId)) {
      warnedTickets.add(ticket.channelId);
      const closeAt = Math.floor((now + (closeAfter - idle)) / 1000);
      await channel
        .send(`⏳ This ticket has gone quiet: it'll auto-close <t:${closeAt}:R> unless there's a reply.`)
        .catch(() => {});
    }
  }
}

export const ticketsModule: BotModule = {
  forget: (_ctx, guildId, userId) => clearCheckSession(guildId, userId),
  name: "tickets",
  commands: [
    featureCommand({
      name: "ticket",
      description: "Support tickets.",
      subcommands: {
        panel: panelSub,
        open: openSub,
        close: closeSub,
        hold: holdSub,
        add: addSub,
        remove: removeSub,
        transcript: transcriptSub,
        check: checkSub,
      },
    }),
  ],
  listeners: [onMessage, onChannelDelete, onReady] as Listener[],
  components: [
    ...checkComponents(openTicketFlow),
    openHandler,
    modalHandler,
    closeHandler,
    closeConfirmHandler,
    closeCancelHandler,
  ],
};
