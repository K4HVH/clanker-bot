import { Events, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { planAuditEntry, removalTargetId } from "../../lib/audit-log";
import { CONFIG_KEYS } from "../../lib/config";
import { suppressedDeletions } from "../../lib/log-suppress";
import {
  buildBulkDeleteEmbed,
  buildMemberJoinEmbed,
  buildMemberLeaveEmbed,
  buildMessageDeleteEmbed,
  buildMessageUpdateEmbed,
  buildNicknameEmbed,
  logMemberEvent,
  logModAlert,
} from "../../lib/modlog";
import { channelIsVerify, inVerifyChannel } from "../../lib/verify-channel";

function logEnabled(ctx: AppContext, guildId: string, key: string): boolean {
  return ctx.config.getEffective<boolean>(guildId, key);
}

// A member removed by a mod (kick/ban) very recently: the plain "left" line skips them —
// the attributed kick/ban goes to the mod-log instead. The leave log defers a few seconds so
// the audit-log event can land first regardless of gateway ordering.
const modRemoved = new Map<string, number>();
const MOD_REMOVED_TTL_MS = 15_000;
const LEAVE_DEFER_MS = 4000;

function markModRemoved(userId: string): void {
  modRemoved.set(userId, Date.now());
  if (modRemoved.size > 500) {
    const cutoff = Date.now() - MOD_REMOVED_TTL_MS;
    for (const [id, t] of modRemoved) if (t < cutoff) modRemoved.delete(id);
  }
}

function wasModRemoved(userId: string): boolean {
  const t = modRemoved.get(userId);
  if (t === undefined) return false;
  modRemoved.delete(userId);
  return Date.now() - t <= MOD_REMOVED_TTL_MS;
}

const onDelete: Listener<Events.MessageDelete> = {
  event: Events.MessageDelete,
  async handle(ctx, message) {
    // Skip deletions the bot performed on purpose (e.g. a typed verification code).
    if (suppressedDeletions.delete(message.id)) return;
    if (!message.guild || message.author?.bot) return;
    // The verify channel is transient scratch (codes + scrubbed spam), not audit material.
    if (inVerifyChannel(ctx, message)) return;
    if (!logEnabled(ctx, message.guild.id, CONFIG_KEYS.logMessageEvents)) return;
    await logMemberEvent(
      ctx,
      message.guild,
      buildMessageDeleteEmbed({
        authorId: message.author?.id,
        channelId: message.channelId,
        content: message.content?.trim() ? message.content : "*(uncached or empty)*",
      }),
    );
  },
};

const onUpdate: Listener<Events.MessageUpdate> = {
  event: Events.MessageUpdate,
  async handle(ctx, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (inVerifyChannel(ctx, newMessage)) return;
    if (!logEnabled(ctx, newMessage.guild.id, CONFIG_KEYS.logMessageEvents)) return;
    const before = oldMessage.content ?? "";
    const after = newMessage.content ?? "";
    if (before === after) return;
    await logMemberEvent(
      ctx,
      newMessage.guild,
      buildMessageUpdateEmbed({
        authorId: newMessage.author?.id,
        channelId: newMessage.channelId,
        before: before.trim() ? before : "*(uncached or empty)*",
        after: after.trim() ? after : "*(empty)*",
      }),
    );
  },
};

const onBulkDelete: Listener<Events.MessageBulkDelete> = {
  event: Events.MessageBulkDelete,
  async handle(ctx, messages, channel) {
    const guild = "guild" in channel ? channel.guild : null;
    if (!guild) return;
    if (!logEnabled(ctx, guild.id, CONFIG_KEYS.logMessageEvents)) return;
    if (channelIsVerify(ctx, guild.id, channel)) return;
    await logMemberEvent(ctx, guild, buildBulkDeleteEmbed({ channelId: channel.id, count: messages.size }));
  },
};

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    if (!logEnabled(ctx, member.guild.id, CONFIG_KEYS.logMemberEvents)) return;
    await logMemberEvent(
      ctx,
      member.guild,
      buildMemberJoinEmbed({ userId: member.id, createdAt: member.user.createdTimestamp }),
    );
  },
};

const onLeave: Listener<Events.GuildMemberRemove> = {
  event: Events.GuildMemberRemove,
  async handle(ctx, member) {
    if (!logEnabled(ctx, member.guild.id, CONFIG_KEYS.logMemberEvents)) return;
    const { guild } = member;
    const userId = member.id;
    // Snapshot the member now: they're dropped from the cache as this event fires and the log
    // is deferred, so reading any of it later would find nothing. A member the bot never had
    // cached arrives partial — no join date or roles ever existed to read, and leaving those
    // undefined is what makes the embed say "unknown" instead of inventing "none".
    const details = {
      userId,
      createdAt: member.user.createdTimestamp,
      joinedAt: member.partial ? undefined : member.joinedTimestamp,
      leftAt: Date.now(),
      roleIds: member.partial
        ? undefined
        : member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.id),
    };
    // Wait for a possible kick/ban audit entry to arrive, then only log a plain "left" if
    // this wasn't a mod/bot removal (those are logged elsewhere: an attributed mod-log line
    // for a human, or a case for the bot's own). Runs outside the listener error boundary,
    // so guard the promise itself.
    setTimeout(() => {
      if (wasModRemoved(userId)) return;
      void logMemberEvent(ctx, guild, buildMemberLeaveEmbed(details)).catch(() => {});
    }, LEAVE_DEFER_MS).unref?.();
  },
};

const onMemberUpdate: Listener<Events.GuildMemberUpdate> = {
  event: Events.GuildMemberUpdate,
  async handle(ctx, oldMember, newMember) {
    if (!logEnabled(ctx, newMember.guild.id, CONFIG_KEYS.logMemberEvents)) return;
    // An uncached member's "before" is synthesised from the gateway payload's user alone, so
    // its nickname is null regardless of the real one — comparing against it would report a
    // nickname set on every role/timeout change. We can't know the old nickname, so say nothing.
    if (oldMember.partial) return;
    // Only nickname changes here — role and timeout changes are attributed via the audit stream.
    const before = oldMember.nickname ?? null;
    const after = newMember.nickname ?? null;
    if (before === after) return;
    await logMemberEvent(ctx, newMember.guild, buildNicknameEmbed({ userId: newMember.id, before, after }));
  },
};

// Attributed manual actions (bans/kicks/timeouts/role & channel changes) done outside the
// bot. The bot's own actions are dropped by planAuditEntry (already logged as cases).
const onAudit: Listener<Events.GuildAuditLogEntryCreate> = {
  event: Events.GuildAuditLogEntryCreate,
  async handle(ctx, entry, guild) {
    const botId = guild.client.user.id;

    // The bot's OWN ban/kick is already logged as a case — don't re-log it, but DO suppress
    // the duplicate "Member left" it would otherwise produce in the member-log.
    if (entry.executorId === botId) {
      const removed = removalTargetId(entry);
      if (removed) markModRemoved(removed);
      return;
    }

    const plan = planAuditEntry(entry, botId);
    if (!plan) return;
    // Opted out of this event group — don't log it. For a removal, we also leave the plain
    // "left" line to stand (unmarked) so the departure isn't invisible.
    if (!logEnabled(ctx, guild.id, plan.toggle)) return;
    // We're logging the attributed removal, so suppress the plain "left" for it.
    if (plan.removedMemberId) markModRemoved(plan.removedMemberId);
    if (plan.destination === "mod") await logModAlert(ctx, guild, plan.embed);
    else await logMemberEvent(ctx, guild, plan.embed);
  },
};

// Attribution needs View Audit Log; warn (don't fail) if we lack it, so the operator knows
// manual actions won't be attributed rather than silently getting no mod-action logs.
const onReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle(ctx, client) {
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (me && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        ctx.logger.warn(
          "logging: missing View Audit Log — manual bans/kicks/timeouts/role/channel changes won't be attributed",
          { guildId: guild.id },
        );
      }
    }
  },
};

export const loggingModule: BotModule = {
  name: "logging",
  listeners: [
    onDelete,
    onUpdate,
    onBulkDelete,
    onJoin,
    onLeave,
    onMemberUpdate,
    onAudit,
    onReady,
  ] as Listener[],
};
