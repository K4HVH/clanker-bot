import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  InteractionContextType,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { BotModule, ComponentHandler, ContextCommand } from "../../core/module";
import { clearCases, listCasesByUser } from "../../db/cases";
import { removeSignature, type SignatureKind } from "../../db/scam-signature";
import { scheduleAction } from "../../db/scheduled";
import { CONFIG_KEYS } from "../../lib/config";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../lib/duration";
import { deleteSuppressed, suppressDeletion, suppressedDeletions } from "../../lib/log-suppress";
import { logModAlert } from "../../lib/modlog";
import { messageMatchesPurge, type PurgeCriteria } from "../../lib/purge";
import {
  type Evidence,
  evidenceOf,
  invalidateSignatures,
  seedFromEvidence,
  seededReply,
  takeForgetToken,
} from "../../lib/scam-signatures";
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

const untimeoutSub: Subcommand = {
  description: "Lift a member's timeout early.",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const member = await assertActionable(interaction, user.id, { requireMember: true });
    if (member === null || member === "not-member") return;

    const until = member.communicationDisabledUntil?.getTime() ?? 0;
    if (until <= Date.now()) {
      await interaction.reply({ content: `${user.tag} isn't currently timed out.`, flags: MessageFlags.Ephemeral });
      return;
    }

    await member.timeout(null, reason);
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "untimeout",
      reason,
      dmText: `Your timeout in **${interaction.guild?.name}** was lifted. Reason: ${reason}`,
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

const BULK_MAX_AGE_MS = 14 * 86_400_000; // Discord's bulk endpoint refuses anything older
const PURGE_MAX_COUNT = 1000; // messages to SCAN per channel
const PURGE_TIME_BUDGET_MS = 10 * 60_000; // overall wall-clock cap, safely under the 15m token
const PENDING_TTL_MS = 5 * 60_000;

// A confirm/pick flow in progress. Keyed by the originating interaction id (which also rides in
// the component customIds). Kept in memory only: a lost one just means "run the command again".
interface PendingPurge {
  requesterId: string;
  count: number;
  userId: string | null;
  filter: string | null;
  channelIds: string[]; // resolved for "all"; filled in by the picker for "pick"
  createdAt: number;
}
const pendingPurges = new Map<string, PendingPurge>();
function sweepPending(): void {
  const now = Date.now();
  for (const [k, v] of pendingPurges) if (now - v.createdAt > PENDING_TTL_MS) pendingPurges.delete(k);
}

// The bot can read + delete in this channel (perms only, any text-based channel incl. threads).
function botHasPurgePerms(guild: Guild, channel: GuildBasedChannel): boolean {
  const me = guild.members.me;
  const perms = me && channel.permissionsFor(me);
  return (
    !!perms &&
    perms.has(PermissionFlagsBits.ViewChannel) &&
    perms.has(PermissionFlagsBits.ReadMessageHistory) &&
    perms.has(PermissionFlagsBits.ManageMessages)
  );
}

// A text/announcement channel the bot can act in: the set eligible for a multi-channel purge.
function botCanPurge(guild: Guild, channel: GuildBasedChannel): channel is GuildTextBasedChannel {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return false;
  return botHasPurgePerms(guild, channel);
}
function purgeableChannels(guild: Guild): GuildTextBasedChannel[] {
  return [...guild.channels.cache.values()].filter((c): c is GuildTextBasedChannel => botCanPurge(guild, c));
}

// The INVOKER's own Manage Messages in a specific channel, so a channel-scoped moderator can't
// borrow the bot's reach to purge channels they can't normally moderate.
function memberCanManage(channel: GuildBasedChannel, member: GuildMember): boolean {
  return channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageMessages) ?? false;
}

type Progress = (text: string) => Promise<void>;

interface PurgeResult {
  deleted: number;
  channelsHit: number;
  oldRemaining: number; // >14-day messages we ran out of time to individually delete
  timedOut: boolean; // hit the time budget before covering every channel
}

// Scan up to `scanLimit` recent messages in one channel and delete the matches: recent ones in
// fast bulk batches, >14-day ones individually (slow) until the shared deadline.
async function purgeChannel(
  channel: GuildTextBasedChannel,
  criteria: PurgeCriteria,
  scanLimit: number,
  deadline: number,
): Promise<{ deleted: number; oldRemaining: number }> {
  const toDelete: Message[] = [];
  let scanned = 0;
  let before: string | undefined;
  while (scanned < scanLimit && Date.now() < deadline) {
    const limit = Math.min(100, scanLimit - scanned);
    const batch = await channel.messages.fetch({ limit, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    scanned += batch.size;
    before = batch.last()?.id;
    for (const m of batch.values()) {
      const p = { authorId: m.author.id, authorBot: m.author.bot, content: m.content, attachmentCount: m.attachments.size };
      if (messageMatchesPurge(p, criteria)) toDelete.push(m);
    }
    if (batch.size < limit) break; // reached the start of history
  }

  const now = Date.now();
  const recent = toDelete.filter((m) => now - m.createdTimestamp < BULK_MAX_AGE_MS);
  const old = toDelete.filter((m) => now - m.createdTimestamp >= BULK_MAX_AGE_MS);

  let deleted = 0;
  for (let i = 0; i < recent.length; i += 100) {
    const slice = recent.slice(i, i + 100);
    const one = slice[0];
    // Suppress every id up front (don't re-surface purged content in the member-log). Suppress the
    // whole slice, not just the lone-message branch: bulkDelete's own 14-day filter can trim a
    // 2+ slice down to one, at which point discord.js falls back to a single DELETE that fires a
    // per-message MessageDelete, which would otherwise be echoed.
    for (const m of slice) suppressDeletion(m.id);
    if (slice.length === 1 && one) {
      // Discord's bulk endpoint needs 2+; a lone message is deleted directly.
      if (await one.delete().then(() => true).catch(() => false)) deleted++;
      else suppressedDeletions.delete(one.id);
    } else {
      const removed = await channel.bulkDelete(slice, true).catch(() => null);
      deleted += removed?.size ?? 0;
    }
  }

  let oldRemaining = 0;
  for (let i = 0; i < old.length; i++) {
    if (Date.now() >= deadline) {
      oldRemaining = old.length - i;
      break;
    }
    const m = old[i];
    if (!m) continue;
    if (await deleteSuppressed(m.id, () => m.delete())) deleted++;
  }
  return { deleted, oldRemaining };
}

// Purge across one or more channels under a single wall-clock budget, reporting progress.
async function runPurge(
  channels: GuildTextBasedChannel[],
  criteria: PurgeCriteria,
  scanLimit: number,
  onProgress: Progress,
): Promise<PurgeResult> {
  const deadline = Date.now() + PURGE_TIME_BUDGET_MS;
  let deleted = 0;
  let channelsHit = 0;
  let oldRemaining = 0;
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    if (!channel) continue;
    if (Date.now() >= deadline) return { deleted, channelsHit, oldRemaining, timedOut: true };
    if (channels.length > 1) {
      await onProgress(`🧹 Purging… ${deleted} deleted (channel ${i + 1}/${channels.length}: <#${channel.id}>)`);
    }
    const res = await purgeChannel(channel, criteria, scanLimit, deadline);
    if (res.deleted > 0) channelsHit++;
    deleted += res.deleted;
    oldRemaining += res.oldRemaining;
  }
  return { deleted, channelsHit, oldRemaining, timedOut: false };
}

function purgeSummary(res: PurgeResult): string {
  if (res.deleted === 0 && res.oldRemaining === 0 && !res.timedOut) {
    return "Nothing matched to delete in the scanned range.";
  }
  const across = res.channelsHit > 1 ? ` across ${res.channelsHit} channels` : "";
  let s = `🧹 Deleted **${res.deleted}** message${res.deleted === 1 ? "" : "s"}${across}.`;
  if (res.oldRemaining > 0) {
    s += `\n-# ${res.oldRemaining} message${res.oldRemaining === 1 ? "" : "s"} older than 14 days couldn't be finished in time (rate limits): re-run to continue.`;
  } else if (res.timedOut) {
    s += "\n-# Stopped at the time limit before every channel was covered: re-run to continue.";
  }
  return s;
}

function purgeDetail(userId: string | null, filter: string | null): string {
  return [userId ? `from <@${userId}>` : null, filter ? `(${filter})` : null].filter(Boolean).join(" ");
}

function confirmText(count: number, userId: string | null, filter: string | null, channelCount: number): string {
  const who = userId ? `<@${userId}>'s messages` : "messages";
  const filt = filter ? ` (${filter})` : "";
  return (
    `⚠️ Purge **${who}${filt}**, scanning up to **${count}** per channel, across **${channelCount}** ` +
    `channel${channelCount === 1 ? "" : "s"}?\nMessages older than 14 days are deleted one-by-one (slower). **This can't be undone.**`
  );
}

function confirmRow(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`purge_confirm:${token}`).setLabel("Purge").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`purge_cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

function channelSelectRow(token: string): ActionRowBuilder<ChannelSelectMenuBuilder> {
  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`purge_pick:${token}`)
      .setPlaceholder("Choose channels…")
      .setMinValues(1)
      .setMaxValues(25)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
}

// Edit-throttle progress so a long multi-channel purge doesn't spam the interaction edit route.
function throttledReporter(edit: (text: string) => Promise<unknown>): Progress {
  let last = 0;
  return async (text) => {
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    await edit(text).catch(() => {});
  };
}

async function logPurge(
  ctx: Parameters<typeof logModAlert>[0],
  guild: Guild,
  byId: string,
  res: PurgeResult,
  userId: string | null,
  filter: string | null,
  channelIds: string[],
): Promise<void> {
  const scope = channelIds.length === 1 && channelIds[0] ? `<#${channelIds[0]}>` : `${channelIds.length} channels`;
  const detail = purgeDetail(userId, filter);
  await logModAlert(
    ctx,
    guild,
    new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("🧹 Messages purged")
      .addFields(
        { name: "Scope", value: scope },
        { name: "By", value: `<@${byId}>` },
        {
          name: "Deleted",
          value: `${res.deleted}${detail ? ` ${detail}` : ""}${res.oldRemaining ? ` (+${res.oldRemaining} older left)` : ""}`,
        },
      )
      .setTimestamp(new Date()),
  );
}

const purgeSub: Subcommand = {
  description: "Delete messages: here, across channels, or clean up one user server-wide.",
  permission: PermissionFlagsBits.ManageMessages,
  options: (s) =>
    s
      .addIntegerOption((o) =>
        o
          .setName("count")
          .setDescription(`Messages to scan per channel (1-${PURGE_MAX_COUNT})`)
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(PURGE_MAX_COUNT),
      )
      .addUserOption((o) => o.setName("user").setDescription("Only delete messages from this user"))
      .addStringOption((o) =>
        o
          .setName("filter")
          .setDescription("Only delete messages matching this")
          .addChoices(
            { name: "Bots only", value: "bots" },
            { name: "Humans only", value: "humans" },
            { name: "With a link", value: "links" },
            { name: "With an attachment", value: "attachments" },
          ),
      )
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Where to purge (default: this channel)")
          .addChoices(
            { name: "This channel", value: "here" },
            { name: "All channels (needs a user)", value: "all" },
            { name: "Pick channels…", value: "pick" },
          ),
      ),
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guild) return;
    const count = interaction.options.getInteger("count", true);
    const user = interaction.options.getUser("user");
    const filter = interaction.options.getString("filter");
    const scope = interaction.options.getString("scope") ?? "here";
    const criteria: PurgeCriteria = { userId: user?.id, filter };

    if (scope === "here") {
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased() || channel.isDMBased() || !("bulkDelete" in channel)) {
        await interaction.reply({ content: "Run this in a server text channel.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!botHasPurgePerms(interaction.guild, channel as GuildTextBasedChannel)) {
        await interaction.reply({
          content: "I need View Channel, Read Message History, and Manage Messages here to purge.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await runPurge([channel as GuildTextBasedChannel], criteria, count, async () => {});
      // Audit-log independent of the reply edit: a failed editReply mustn't lose the record.
      await interaction.editReply(purgeSummary(res)).catch(() => {});
      if (res.deleted > 0) await logPurge(ctx, interaction.guild, interaction.user.id, res, user?.id ?? null, filter, [channel.id]);
      return;
    }

    if (scope === "all") {
      if (!user) {
        await interaction.reply({
          content:
            "A server-wide purge needs a **user** target (safety, so it can't wipe every channel for everyone). Add `user:`, or use **Pick channels** to purge whole channels.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const invoker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!invoker) {
        await interaction.reply({ content: "Couldn't resolve your permissions. Try again.", flags: MessageFlags.Ephemeral });
        return;
      }
      const channels = purgeableChannels(interaction.guild).filter((c) => memberCanManage(c, invoker));
      if (channels.length === 0) {
        await interaction.reply({ content: "No text channels where both you and I have Manage Messages.", flags: MessageFlags.Ephemeral });
        return;
      }
      sweepPending();
      pendingPurges.set(interaction.id, {
        requesterId: interaction.user.id,
        count,
        userId: user.id,
        filter,
        channelIds: channels.map((c) => c.id),
        createdAt: Date.now(),
      });
      await interaction.reply({
        content: confirmText(count, user.id, filter, channels.length),
        components: [confirmRow(interaction.id)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // scope === "pick"
    sweepPending();
    pendingPurges.set(interaction.id, {
      requesterId: interaction.user.id,
      count,
      userId: user?.id ?? null,
      filter,
      channelIds: [],
      createdAt: Date.now(),
    });
    await interaction.reply({
      content: "Select the channels to purge, then confirm:",
      components: [channelSelectRow(interaction.id)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const purgePickHandler: ComponentHandler = {
  customId: "purge_pick",
  type: "select",
  match: "prefix",
  async handle(interaction) {
    if (!interaction.isChannelSelectMenu()) return;
    const token = interaction.customId.split(":")[1] ?? "";
    const pending = pendingPurges.get(token);
    if (!pending || pending.requesterId !== interaction.user.id || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      pendingPurges.delete(token);
      await interaction.update({ content: "This purge selection expired. Run `/mod purge` again.", components: [] });
      return;
    }
    pending.channelIds = [...interaction.values];
    pending.createdAt = Date.now(); // refresh the TTL now that they've engaged
    await interaction.update({
      content: confirmText(pending.count, pending.userId, pending.filter, pending.channelIds.length),
      components: [confirmRow(token)],
    });
  },
};

const purgeConfirmHandler: ComponentHandler = {
  customId: "purge_confirm",
  type: "button",
  match: "prefix",
  async handle(interaction, ctx) {
    if (!interaction.isButton() || !interaction.inGuild() || !interaction.guild) return;
    const token = interaction.customId.split(":")[1] ?? "";
    const pending = pendingPurges.get(token);
    if (!pending || pending.requesterId !== interaction.user.id || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      pendingPurges.delete(token);
      await interaction.update({ content: "This purge expired or isn't yours. Run `/mod purge` again.", components: [] });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.update({ content: "You need the Manage Messages permission.", components: [] });
      return;
    }
    // Claim the pending synchronously (before any await) so a double-click can't run it twice.
    pendingPurges.delete(token);
    const guild = interaction.guild;
    const invoker = await guild.members.fetch(interaction.user.id).catch(() => null);
    const channels = pending.channelIds
      .map((id) => guild.channels.cache.get(id))
      .filter((c): c is GuildTextBasedChannel => !!c && botCanPurge(guild, c) && !!invoker && memberCanManage(c, invoker));
    if (channels.length === 0) {
      await interaction.update({
        content: "None of those channels are purgeable: either I lack Manage Messages there, or you do.",
        components: [],
      });
      return;
    }
    await interaction.update({
      content: `🧹 Purging across ${channels.length} channel${channels.length === 1 ? "" : "s"}…`,
      components: [],
    });
    const report = throttledReporter((text) => interaction.editReply(text));
    const criteria: PurgeCriteria = { userId: pending.userId ?? undefined, filter: pending.filter };
    const res = await runPurge(channels, criteria, pending.count, report);
    await interaction.editReply(purgeSummary(res)).catch(() => {});
    if (res.deleted > 0) {
      await logPurge(ctx, guild, interaction.user.id, res, pending.userId, pending.filter, channels.map((c) => c.id));
    }
  },
};

const purgeCancelHandler: ComponentHandler = {
  customId: "purge_cancel",
  type: "button",
  match: "prefix",
  async handle(interaction) {
    if (!interaction.isButton()) return;
    const token = interaction.customId.split(":")[1] ?? "";
    pendingPurges.delete(token);
    await interaction.update({ content: "Purge cancelled.", components: [] });
  },
};

const purgeComponents: ComponentHandler[] = [purgePickHandler, purgeConfirmHandler, purgeCancelHandler];

const clearHistorySub: Subcommand = {
  description: "Clear a user's automod violations (resets escalation) or their full history.",
  permission: PermissionFlagsBits.ModerateMembers,
  options: (s) =>
    s
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("What to clear (default: automod violations)")
          .addChoices(
            { name: "Automod violations (resets the escalation ladder)", value: "automod" },
            { name: "Full moderation history", value: "all" },
          ),
      ),
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guild) return;
    const user = interaction.options.getUser("user", true);
    const automodOnly = (interaction.options.getString("scope") ?? "automod") === "automod";
    const n = clearCases(ctx.db, interaction.guildId, user.id, {
      automodOnly,
      botId: interaction.client.user.id,
    });
    const label = automodOnly
      ? `${n} automod violation${n === 1 ? "" : "s"}`
      : `${n} history ${n === 1 ? "entry" : "entries"}`;
    await interaction.reply({
      content: `🧹 Cleared ${label} for ${user.tag}.`,
      flags: MessageFlags.Ephemeral,
    });
    if (n > 0) {
      await logModAlert(
        ctx,
        interaction.guild,
        new EmbedBuilder()
          .setColor(0x95a5a6)
          .setTitle("🧹 Moderation history cleared")
          .addFields(
            { name: "User", value: `<@${user.id}> (${user.id})` },
            { name: "By", value: `<@${interaction.user.id}>` },
            { name: "Cleared", value: `${n} ${automodOnly ? "automod violation(s)" : "history entr(ies)"}` },
          )
          .setTimestamp(new Date()),
      );
    }
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
        content: `No moderation history for ${user.tag}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Build whole lines up to a safe budget (never slice mid-tag, which would render as
    // literal text), truncating long reasons; note if any didn't fit.
    const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const lines: string[] = [];
    let used = 0;
    for (const r of records) {
      const line = `\`${r.type}\` · <t:${Math.floor(r.createdAt / 1000)}:d>: ${trunc(r.reason, 180)}`;
      if (used + line.length + 1 > 3900) {
        lines.push(`…and ${records.length - lines.length} more`);
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Moderation history: ${user.tag}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `${records.length} most recent` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

// ── Scam signature list (automod data, managed like /mod clearhistory) ────────
const SCAM_MSG_LINK = /channels\/(\d+)\/(\d+)\/(\d+)/;

const scamSeedSub: Subcommand = {
  description: "Add a scam signature from a message, some text, or an image.",
  permission: PermissionFlagsBits.ManageGuild,
  options: (s) =>
    s
      .addStringOption((o) => o.setName("message").setDescription("A message link or ID to take domains + image from"))
      .addStringOption((o) => o.setName("text").setDescription("A scam domain or text to pull domains from"))
      .addAttachmentOption((o) => o.setName("image").setDescription("A scam image to hash and block")),
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guild) return;
    const messageRef = interaction.options.getString("message");
    const text = interaction.options.getString("text");
    const image = interaction.options.getAttachment("image");
    if (!messageRef && !text && !image) {
      await interaction.reply({ content: "Give a message, some text, or an image to seed from.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Defer before the fetch + image download/hash, which can exceed Discord's 3s ack window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const evidence: Evidence = { content: text ?? "", attachments: [] };
    if (image) {
      evidence.attachments.push({
        url: image.url,
        size: image.size,
        width: image.width ?? null,
        height: image.height ?? null,
        name: image.name,
      });
    }
    if (messageRef) {
      const m = messageRef.match(SCAM_MSG_LINK);
      const channelId = m ? m[2] : interaction.channelId;
      const messageId = m ? m[3] : /^\d{17,20}$/.test(messageRef.trim()) ? messageRef.trim() : null;
      if (!channelId || !messageId) {
        await interaction.editReply("The message reference wasn't a link or an ID.");
        return;
      }
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      const target = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
      if (!target) {
        await interaction.editReply("Couldn't fetch that message.");
        return;
      }
      const e = evidenceOf(target);
      evidence.content = `${evidence.content} ${e.content}`.trim();
      evidence.attachments.push(...e.attachments);
    }
    const added = await seedFromEvidence(ctx, interaction.guild.id, "manual", evidence);
    await interaction.editReply(seededReply(added));
  },
};

const scamForgetSub: Subcommand = {
  description: "Remove a scam signature from the list.",
  permission: PermissionFlagsBits.ManageGuild,
  options: (s) =>
    s
      .addStringOption((o) =>
        o
          .setName("kind")
          .setDescription("Signature kind")
          .setRequired(true)
          .addChoices({ name: "domain", value: "domain" }, { name: "sha256", value: "sha256" }, { name: "triple", value: "triple" }),
      )
      .addStringOption((o) => o.setName("value").setDescription("The exact value to remove").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const kind = interaction.options.getString("kind", true) as SignatureKind;
    const value = interaction.options.getString("value", true);
    const removed = removeSignature(ctx.db, interaction.guildId, kind, value);
    invalidateSignatures(interaction.guildId);
    await interaction.reply({ content: removed > 0 ? "Removed." : "No matching signature.", flags: MessageFlags.Ephemeral });
  },
};

// Right-click a message, Apps, Seed scam signature.
const scamSeedContext: ContextCommand = {
  data: new ContextMenuCommandBuilder()
    .setName("Seed scam signature")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const added = await seedFromEvidence(ctx, interaction.guildId, "manual", evidenceOf(interaction.targetMessage));
    await interaction.editReply(seededReply(added));
  },
};

// The "Not a scam" button automod posts on a match alert.
const scamForgetButtonHandler: ComponentHandler = {
  customId: "scam:forget",
  type: "button",
  match: "prefix",
  async handle(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guildId) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = takeForgetToken(interaction.customId.slice("scam:forget:".length));
    if (!target) {
      await interaction.reply({ content: "That correction expired. Use `/mod scamforget` instead.", flags: MessageFlags.Ephemeral });
      return;
    }
    const removed = removeSignature(ctx.db, interaction.guildId, target.kind, target.value);
    invalidateSignatures(interaction.guildId);
    await interaction.reply({
      content: removed > 0 ? `Removed \`${target.kind}\` from the scam list.` : "That signature was already gone.",
      flags: MessageFlags.Ephemeral,
    });
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
        untimeout: untimeoutSub,
        kick: kickSub,
        ban: banSub,
        unban: unbanSub,
        purge: purgeSub,
        history: historySub,
        clearhistory: clearHistorySub,
        scamseed: scamSeedSub,
        scamforget: scamForgetSub,
      },
    }),
  ],
  contextCommands: [scamSeedContext],
  components: [...purgeComponents, scamForgetButtonHandler],
};
