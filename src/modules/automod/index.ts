import { Events, type GuildMember, type Message, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { countAutomodViolations, createCase, listAutomodActions } from "../../db/cases";
import { getTicketByChannel } from "../../db/tickets";
import { getChallenge } from "../../db/verification";
import { checkContent, type ContentRules, decideEscalation, type Tier } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { HeatTracker, RepeatTracker } from "../../lib/heat";
import { suppressDeletion, suppressedDeletions } from "../../lib/log-suppress";
import { logCase } from "../../lib/modlog";
import { inVerifyChannel } from "../../lib/verify-channel";
import { isCodeShaped } from "../../lib/verification-logic";

const heat = new HeatTracker();
const repeats = new RepeatTracker();

// A message SENT within this window of a user's last action takes no new action, so a burst
// collapses into one action instead of a stack. It's measured against the message's send time
// (not our processing time), so it can be short without a slow backlog leaking a second action —
// just long enough to absorb a burst + minor clock skew. New violations sent later climb normally.
const ESCALATION_COOLDOWN_MS = 5_000;

const RANK: Record<string, number> = { timeout: 1, kick: 2, ban: 3 };

// Serialize each user's violation handling so a burst is processed one message at a time — the
// warn is written and counted before the next message's escalation reads the count. Without this,
// discord.js dispatches burst handlers concurrently and their interleaved counts can jump a user
// past a tier (straight to kick from zero). Different users still run concurrently.
const userLocks = new Map<string, Promise<unknown>>();
function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  userLocks.set(key, tail);
  tail.finally(() => {
    if (userLocks.get(key) === tail) userLocks.delete(key);
  });
  return run;
}

function contentRulesFor(ctx: AppContext, guildId: string): ContentRules {
  return {
    invites: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodInvites),
    links: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodLinks),
    linkAllowlist: ctx.config.getEffective<string>(guildId, CONFIG_KEYS.automodLinkAllowlist) ?? "",
    wordBlocklist: ctx.config.getEffective<string>(guildId, CONFIG_KEYS.automodWordBlocklist) ?? "",
    mentionLimit: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodMentionLimit),
    massMention: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodMassMention),
    caps: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodCaps),
  };
}

function anyRuleEnabled(rules: ContentRules, flood: boolean, duplicates: boolean): boolean {
  return (
    rules.invites ||
    rules.links ||
    !!rules.wordBlocklist.trim() ||
    rules.mentionLimit > 0 ||
    rules.massMention ||
    rules.caps ||
    flood ||
    duplicates
  );
}

// The enabled escalation tiers, in ascending severity. A threshold of 0 means that tier is off.
function enabledTiers(ctx: AppContext, guildId: string): Tier[] {
  return [
    { type: "timeout" as const, at: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodTimeoutAt), rank: 1 },
    { type: "kick" as const, at: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodKickAt), rank: 2 },
    { type: "ban" as const, at: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodBanAt), rank: 3 },
  ].filter((t) => t.at > 0);
}

// Apply at most ONE escalation for this violation, chosen by decideEscalation (one tier at a time,
// one action per burst). Ladder state (how far the user has climbed, when they were last actioned)
// is derived from the DB so it survives restarts + history clears. Returns true when the caller
// should suppress the "message removed" DM (we acted, or we're mid-burst after an action). Won't
// touch the owner, a member above the bot, or act without the permission — the delete + warn stand.
async function escalate(
  ctx: AppContext,
  message: Message,
  member: GuildMember | null,
  botId: string,
): Promise<boolean> {
  const guild = message.guild;
  if (!guild) return false;
  const guildId = guild.id;
  const userId = message.author.id;
  const now = Date.now();

  const tiers = enabledTiers(ctx, guildId);
  if (tiers.length === 0) return false;

  const ttlMin = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodViolationTtlMinutes);
  const sinceMs = now - ttlMin * 60_000;
  const count = countAutomodViolations(ctx.db, guildId, userId, botId, sinceMs);
  const actions = listAutomodActions(ctx.db, guildId, userId, botId, sinceMs);
  const appliedRank = actions.reduce((m, a) => Math.max(m, RANK[a.type] ?? 0), 0);
  const lastActionAt = actions.reduce((m, a) => Math.max(m, a.createdAt), 0);

  const decision = decideEscalation({
    count,
    tiers,
    appliedRank,
    lastActionAt,
    messageSentAt: message.createdTimestamp,
    cooldownMs: ESCALATION_COOLDOWN_MS,
  });
  if (!decision.action) return decision.suppressWarnDm;
  const type = decision.action.type;

  // The user just sent a message, so they're present: require the bot to outrank them (and not be
  // the owner) and hold the permission, or skip silently — avoids a doomed API call + a lying DM.
  const me = guild.members.me;
  const outranks =
    !!me && !!member && userId !== guild.ownerId && member.roles.highest.position < me.roles.highest.position;
  const perm =
    type === "ban"
      ? PermissionFlagsBits.BanMembers
      : type === "kick"
        ? PermissionFlagsBits.KickMembers
        : PermissionFlagsBits.ModerateMembers;
  if (!outranks || !me?.permissions.has(perm)) return false;

  const reason = `Automod: ${count} violations in ${ttlMin}m`;
  const dmEnabled = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction);
  const notify = async () => {
    if (!dmEnabled) return;
    const verb = type === "ban" ? "banned from" : type === "kick" ? "kicked from" : "timed out in";
    await message.author.send(`You were ${verb} **${guild.name}** by automod — ${reason}.`).catch(() => {});
  };

  try {
    if (type === "ban") {
      // DM BEFORE removal — once kicked/banned we no longer share a guild, so the DM would fail.
      await notify();
      await guild.members.ban(userId, { reason });
    } else if (type === "kick") {
      await notify();
      await member?.kick(reason);
    } else {
      const mins = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodTimeoutMinutes);
      await member?.timeout(mins * 60_000, reason);
      await notify(); // still in the guild — DM after so it only sends on success
    }
  } catch {
    return false; // action failed; the delete + warn still stand, so allow the warn DM
  }
  await logCase(ctx, guild, createCase(ctx.db, { guildId, userId, moderatorId: botId, type, reason }));
  return true;
}

async function scan(ctx: AppContext, message: Message, isEdit: boolean): Promise<void> {
  const guild = message.guild;
  if (!guild || message.author.bot || !message.content) return;
  const guildId = guild.id;

  const rules = contentRulesFor(ctx, guildId);
  const flood = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodFlood);
  const duplicates = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodDuplicates);
  if (!anyRuleEnabled(rules, flood, duplicates)) return;

  // Exemptions: staff, the verify channel, ticket channels, and an in-progress verification
  // code typed elsewhere. Resolve the member so the staff check holds even on an edit where
  // message.member wasn't cached.
  const member =
    message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
  if (inVerifyChannel(ctx, message)) return;
  if (
    !ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodModerateTickets) &&
    getTicketByChannel(ctx.db, message.channelId)
  ) {
    return;
  }
  const challenge = getChallenge(ctx.db, guildId, message.author.id);
  if (
    challenge &&
    challenge.expiresAt >= Date.now() &&
    isCodeShaped(message.content.trim().toUpperCase(), challenge.code.length)
  ) {
    return;
  }

  // Content rules run on new AND edited messages (kills the edit-bypass). Don't count the
  // reply-ping toward the mention limit — it's implicit, not spam.
  const repliedTo = message.mentions.repliedUser;
  const replyPing = repliedTo && message.mentions.users.has(repliedTo.id) ? 1 : 0;
  const mentionCount = message.mentions.users.size + message.mentions.roles.size - replyPing;
  let violation = checkContent(
    message.content,
    { mentionCount, massMention: message.mentions.everyone },
    rules,
  );

  // Stateful rules only on new messages — an edit doesn't add to flood/duplicate history.
  if (!violation && !isEdit) {
    const windowMs = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodFloodSeconds) * 1000;
    const now = Date.now();
    if (
      flood &&
      heat.record(guildId, message.author.id, now, windowMs, ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodFloodMessages))
    ) {
      violation = "message flood";
    } else if (duplicates && repeats.record(`${guildId}:${message.author.id}`, message.content, now, windowMs)) {
      violation = "duplicate spam";
    }
  }
  if (!violation) return;

  // Delete + record the violation, then escalate on accumulation. Suppress the member-log echo
  // (the mod-log automod entry is the record; don't reprint the removed content).
  suppressDeletion(message.id);
  const deleted = await message.delete().then(() => true).catch(() => false);
  if (!deleted) suppressedDeletions.delete(message.id);
  const botId = message.client.user.id;
  const label = violation;

  // Serialize per user so the warn is counted before the next burst message escalates.
  await runExclusive(`${guildId}:${message.author.id}`, async () => {
    const warn = createCase(ctx.db, {
      guildId,
      userId: message.author.id,
      moderatorId: botId,
      type: "warn",
      reason: `Automod: ${label}`,
    });
    await logCase(ctx, guild, warn);
    const suppressWarnDm = await escalate(ctx, message, member, botId);
    if (!suppressWarnDm && ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction)) {
      await message.author
        .send(`Your message in **${guild.name}** was removed by automod — ${label}.`)
        .catch(() => {});
    }
  });
}

const onCreate: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    await scan(ctx, message, false);
  },
};

const onEdit: Listener<Events.MessageUpdate> = {
  event: Events.MessageUpdate,
  async handle(ctx, oldMessage, newMessage) {
    // MessageUpdate also fires for embed loads, pins, etc. — only re-scan when the CONTENT
    // actually changed, or we'd re-punish (and race the create-scan's delete) on every embed.
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;
    const msg = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (msg) await scan(ctx, msg, true);
  },
};

export const automodModule: BotModule = {
  name: "automod",
  listeners: [onCreate, onEdit] as Listener[],
};
