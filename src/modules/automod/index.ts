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
import { applyModAction } from "../../lib/mod-action";
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
  const tiers = [
    { type: "timeout" as const, at: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodTimeoutAt), rank: 1 },
    { type: "kick" as const, at: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodKickAt), rank: 2 },
    { type: "ban" as const, at: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodBanAt), rank: 3 },
  ].filter((t) => t.at > 0);
  // Keep thresholds non-decreasing with severity, so a misconfigured ladder (e.g. kickAt below
  // timeoutAt) can't make a harsher tier become eligible before a milder one.
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1];
    const cur = tiers[i];
    if (prev && cur && cur.at < prev.at) cur.at = prev.at;
  }
  return tiers;
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
    // On an edit use the edit time, not the original send time — otherwise editing an old
    // (pre-action) message into a fresh violation looks like a straggler and never escalates.
    messageSentAt: message.editedTimestamp ?? message.createdTimestamp,
    cooldownMs: ESCALATION_COOLDOWN_MS,
  });
  if (!decision.action) return decision.suppressWarnDm;
  const type = decision.action.type;

  // The user just sent a message, so they're present. applyModAction runs the shared gate (bot
  // outranks them, not the owner, holds the permission) and takes the action with the correct DM
  // ordering — skipping silently on a failed gate avoids a doomed API call + a lying DM.
  const reason = `Automod: ${count} violations in ${ttlMin}m`;
  const dmEnabled = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction);
  const verb = type === "ban" ? "banned from" : type === "kick" ? "kicked from" : "timed out in";
  const acted = await applyModAction({
    guild,
    member,
    userId,
    type,
    reason,
    dm: dmEnabled ? `You were ${verb} **${guild.name}** by automod — ${reason}.` : undefined,
    timeoutMs:
      type === "timeout"
        ? ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodTimeoutMinutes) * 60_000
        : undefined,
    // Fixes a prior bug: automod bans left the scam messages up. Wipe the configured window.
    deleteMessageSeconds:
      type === "ban"
        ? ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodBanDeleteHours) * 3600
        : undefined,
  });
  if (!acted) return false; // action failed/skipped; the delete + warn still stand, so allow the warn DM

  // Record the action so the ladder advances. Guard the write: the action already happened, so a
  // failed insert should be logged, not thrown — a throw here would skip recording AND could let
  // the next burst message re-act (it derives the cooldown from this row).
  try {
    await logCase(ctx, guild, createCase(ctx.db, { guildId, userId, moderatorId: botId, type, reason }));
  } catch (error) {
    ctx.logger.error("automod: escalated but failed to record the action", {
      guildId,
      userId,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  if (!deleted) {
    // Couldn't remove it (no ManageMessages here, or it's already gone) — don't record a warn,
    // escalate, or tell the user it was "removed" while it's still sitting in the channel.
    suppressedDeletions.delete(message.id);
    return;
  }
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
