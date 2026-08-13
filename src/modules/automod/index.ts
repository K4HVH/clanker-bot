import { EmbedBuilder, Events, type GuildMember, type Message, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { seedOnReady } from "./seeding";
import { countAutomodViolations, createCase, listAutomodActions } from "../../db/cases";
import { bumpSignatureHit } from "../../db/scam-signature";
import { getTicketByChannel } from "../../db/tickets";
import { getChallenge } from "../../db/verification";
import { parseScamAction, type ScamAction } from "../../lib/actions";
import { checkContent, type ContentRules, decideEscalation, type Tier } from "../../lib/automod";
import { Claims } from "../../lib/claim";
import { CONFIG_KEYS } from "../../lib/config";
import { HeatTracker, RepeatTracker, SprayTracker } from "../../lib/heat";
import { inHoneypotChannel } from "../../lib/honeypot";
import { deleteSuppressed } from "../../lib/log-suppress";
import { applyModAction, autoWipeSeconds, autoTimeoutMs } from "../../lib/mod-action";
import { logCase, logModAlert, userValue } from "../../lib/modlog";
import { purgeUserMessages } from "../../lib/purge-user";
import { attachmentTriple } from "../../lib/scam-seed";
import { forgetButton, matchSignatures, type SignatureMatch } from "../../lib/scam-signatures";
import { inVerifyChannel } from "../../lib/verify-channel";
import { isCodeShaped } from "../../lib/verification-logic";

const heat = new HeatTracker();
const repeats = new RepeatTracker();

// A message SENT within this window of a user's last action takes no new action, so a burst
// collapses into one action instead of a stack. It's measured against the message's send time
// (not our processing time), so it can be short without a slow backlog leaking a second action:
// just long enough to absorb a burst + minor clock skew. New violations sent later climb normally.
const ESCALATION_COOLDOWN_MS = 5_000;

const RANK: Record<string, number> = { timeout: 1, kick: 2, ban: 3 };

// Serialize each user's violation handling so a burst is processed one message at a time: the
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
// touch the owner, a member above the bot, or act without the permission: the delete + warn stand.
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
    // On an edit use the edit time, not the original send time. Otherwise editing an old
    // (pre-action) message into a fresh violation looks like a straggler and never escalates.
    messageSentAt: message.editedTimestamp ?? message.createdTimestamp,
    cooldownMs: ESCALATION_COOLDOWN_MS,
  });
  if (!decision.action) return decision.suppressWarnDm;
  const type = decision.action.type;

  // The user just sent a message, so they're present. applyModAction runs the shared gate (bot
  // outranks them, not the owner, holds the permission) and takes the action with the correct DM
  // ordering. Skipping silently on a failed gate avoids a doomed API call and a lying DM.
  const reason = `Automod: ${count} violations in ${ttlMin}m`;
  const dmEnabled = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction);
  const verb = type === "ban" ? "banned from" : type === "kick" ? "kicked from" : "timed out in";
  const acted = await applyModAction({
    guild,
    member,
    userId,
    type,
    reason,
    dm: dmEnabled ? `You were ${verb} **${guild.name}** by automod: ${reason}.` : undefined,
    timeoutMs: type === "timeout" ? autoTimeoutMs(ctx, guildId) : undefined,
    deleteMessageSeconds: type === "ban" ? autoWipeSeconds(ctx, guildId) : undefined,
  });
  if (!acted) return false; // action failed/skipped; the delete + warn still stand, so allow the warn DM

  // Record the action so the ladder advances. Guard the write: the action already happened, so a
  // failed insert should be logged, not thrown: a throw here would skip recording AND could let
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

// ── Confirmed-bad rules: a scam signature match or a cross-channel spray. Unlike the heuristic
// rules these are facts, not guesses, so they act at once with one configured action instead of
// accumulating on the ladder. Both draw the timeout length and ban wipe from Moderation.

const sprays = new SprayTracker();
// Recent message refs per user, so a tripped spray is purged across every channel it hit.
const sprayMsgs = new Map<string, { channelId: string; messageId: string; ts: number }[]>();
// One action per user per burst. flag and delete write no case, so the ladder cooldown can't dedup
// them; this does. Namespaced per rule so one rule's flag can't suppress the other's stronger action.
const decisiveClaims = new Claims(30_000);

function recordSprayMsg(key: string, channelId: string, messageId: string, now: number, windowMs: number): void {
  const list = (sprayMsgs.get(key) ?? []).filter((m) => m.ts > now - windowMs);
  list.push({ channelId, messageId, ts: now });
  sprayMsgs.set(key, list);
  if (sprayMsgs.size > 1000) {
    for (const [k, ms] of sprayMsgs) if (ms.every((m) => m.ts <= now - windowMs)) sprayMsgs.delete(k);
  }
}

async function purgeSpray(guild: Message["guild"], key: string): Promise<void> {
  if (!guild) return;
  for (const ref of sprayMsgs.get(key) ?? []) {
    const channel = guild.channels.cache.get(ref.channelId);
    if (!channel?.isTextBased()) continue;
    await deleteSuppressed(ref.messageId, () => channel.messages.delete(ref.messageId));
  }
  sprayMsgs.delete(key);
}

function firstImageTriple(message: Message): string | null {
  for (const a of message.attachments.values()) {
    const triple = attachmentTriple(a.size, a.width, a.height);
    if (triple) return triple;
  }
  return null;
}

const SCAM_LABEL: Record<ScamAction, string> = {
  off: "Off",
  flag: "Flagged",
  delete: "Deleted",
  timeout: "Timed out",
  kick: "Kicked",
  ban: "Banned",
};

// Take one decisive action for a confirmed-bad signal. Claims the user before the first await so a
// burst collapses into one action. flag alerts only; delete removes the content without penalty;
// timeout/kick/ban also act and record a real case. Content is removed for any enforcing action
// except a ban whose server-side wipe already covered it. Returns nothing; posts the alert itself.
async function actDecisive(
  ctx: AppContext,
  message: Message,
  member: GuildMember | null,
  opts: {
    action: Exclude<ScamAction, "off">;
    claimKey: string;
    reason: string;
    dm?: string;
    onClaimed?: () => void;
    removeContent: () => Promise<void>;
    alert: (label: string) => EmbedBuilder;
    components?: ActionRowLike[];
  },
): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  if (!decisiveClaims.claim(opts.claimKey)) return;
  opts.onClaimed?.();
  const userId = message.author.id;
  const botId = message.client.user.id;

  let effective: ScamAction = opts.action;
  const wipeSeconds = autoWipeSeconds(ctx, guild.id);
  let wiped = false; // ban's native server-side wipe happened
  if (opts.action === "timeout" || opts.action === "kick" || opts.action === "ban") {
    const acted = await applyModAction({
      guild,
      member,
      userId,
      type: opts.action,
      reason: opts.reason,
      timeoutMs: opts.action === "timeout" ? autoTimeoutMs(ctx, guild.id) : undefined,
      deleteMessageSeconds: opts.action === "ban" ? wipeSeconds : undefined,
      dm: opts.dm,
    });
    if (acted) {
      wiped = opts.action === "ban" && wipeSeconds > 0;
      try {
        createCase(ctx.db, { guildId: guild.id, userId, moderatorId: botId, type: opts.action, reason: opts.reason });
      } catch (error) {
        ctx.logger.error("automod: acted on a confirmed-bad signal but failed to record the case", {
          guildId: guild.id,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      // Couldn't apply the penalty (missing permission, target outranks the bot, or unresolvable).
      // Removing the message needs only ManageMessages, so still take it down and label it a delete
      // rather than claiming a ban that didn't happen.
      effective = "delete";
    }
  }

  // Message cleanup. A ban wipes the last N hours server-side; a kick can't, so it purges the
  // user's recent messages to match. timeout, delete, and a wipe-less kick/ban remove the
  // offending content only. flag removes nothing.
  if (effective === "ban") {
    if (!wiped) await opts.removeContent();
  } else if (effective === "kick" && wipeSeconds > 0) {
    await purgeUserMessages(guild, userId, Date.now() - wipeSeconds * 1000);
  } else if (effective !== "flag") {
    await opts.removeContent();
  }

  await logModAlert(ctx, guild, opts.alert(SCAM_LABEL[effective]), { components: opts.components });
}

type ActionRowLike = ReturnType<typeof forgetButton>;

function signatureAlert(
  user: { id: string; username: string },
  channelId: string,
  match: SignatureMatch,
  label: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xd35400)
    .setTitle("🛑 Known scam signature matched")
    .addFields(
      { name: "User", value: userValue(user.id, user.username) },
      { name: "Channel", value: `<#${channelId}>` },
      { name: "Matched", value: `\`${match.kind}\`: \`${match.value.slice(0, 200)}\`` },
      { name: "Action", value: label },
    )
    .setTimestamp(new Date());
}

function sprayAlert(user: { id: string; username: string }, label: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xd35400)
    .setTitle("🚿 Cross-channel spray detected")
    .addFields(
      { name: "User", value: userValue(user.id, user.username) },
      { name: "Action", value: label },
    )
    .setTimestamp(new Date());
}

async function scan(ctx: AppContext, message: Message, isEdit: boolean): Promise<void> {
  const guild = message.guild;
  if (!guild || message.author.bot) return;
  // The honeypot owns its channel: it acts on its own terms, so automod never touches it.
  if (inHoneypotChannel(ctx, message)) return;
  const guildId = guild.id;

  // What's enabled? Confirmed-bad rules (signature, spray) can run while the heuristic rules are off.
  const sigAction = parseScamAction(ctx.config.getEffective(guildId, CONFIG_KEYS.scamSignatureAction));
  const sprayAction = parseScamAction(ctx.config.getEffective(guildId, CONFIG_KEYS.scamSprayAction));
  const rules = contentRulesFor(ctx, guildId);
  const flood = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodFlood);
  const duplicates = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodDuplicates);
  const heuristicsOn = anyRuleEnabled(rules, flood, duplicates);
  if (sigAction === "off" && sprayAction === "off" && !heuristicsOn) return;

  // Ticket channels follow their toggle for every rule (both the heuristic and confirmed-bad rules,
  // matching the pre-refactor behaviour of automod and the old scam checks). The verify-channel
  // exemption is applied to the heuristics only, below, so a seeded scam is still caught there.
  if (
    !ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodModerateTickets) &&
    getTicketByChannel(ctx.db, message.channelId)
  ) {
    return;
  }

  // Resolve the member for the staff checks. Fail-open here (an unresolved member is treated as
  // non-staff), but applyModAction's gate is fail-closed, so a match can never ban an unresolvable
  // moderator.
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  const isStaff = member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
  const now = Date.now();

  // ── Confirmed-bad, first match wins, one action per message ──
  if (sigAction !== "off" && !isStaff) {
    const match = await matchSignatures(ctx, message, now, { skipImages: isEdit });
    if (match) {
      await actDecisive(ctx, message, member, {
        action: sigAction,
        claimKey: `sig:${guildId}:${message.author.id}`,
        reason: `Scam signature (${match.kind})`,
        dm: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction)
          ? `Your message in **${guild.name}** matched a known scam and was actioned.`
          : undefined,
        onClaimed: () => bumpSignatureHit(ctx.db, guildId, match.kind, match.value, now),
        removeContent: () => deleteSuppressed(message.id, () => message.delete()).then(() => {}),
        alert: (label) => signatureAlert(message.author, message.channelId, match, label),
        components: [forgetButton(match.kind, match.value)],
      });
      return;
    }
  }

  if (sprayAction !== "off" && !isEdit && !(isStaff && ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.scamSprayExemptStaff))) {
    const key = `${guildId}:${message.author.id}`;
    const windowMs = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamSpraySeconds) * 1000;
    recordSprayMsg(key, message.channelId, message.id, now, windowMs);
    const fp = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.scamSprayMatchAttachments)
      ? firstImageTriple(message)
      : null;
    const tripped = sprays.record(
      key,
      { channelId: message.channelId, text: message.content, fp, now },
      {
        windowMs,
        minChars: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamSprayMinChars),
        similarity: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamSpraySimilarity),
        channels: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamSprayChannels),
      },
    );
    if (tripped) {
      await actDecisive(ctx, message, member, {
        action: sprayAction,
        claimKey: `spray:${guildId}:${message.author.id}`,
        reason: "Cross-channel spray",
        dm: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction)
          ? `You were actioned in **${guild.name}** for posting the same message across many channels. If this wasn't you, your account may be compromised.`
          : undefined,
        removeContent: () => purgeSpray(guild, key),
        alert: (label) => sprayAlert(message.author, label),
      });
      return;
    }
  }

  // ── Heuristic content + rate rules: require content, exempt staff, accumulate on the ladder ──
  if (!heuristicsOn || !message.content || isStaff) return;
  // The verify channel is auto-scrubbed, so the heuristics skip it (the confirmed-bad rules above
  // still run there, to catch a seeded scam a verified hijacked account posts in it).
  if (inVerifyChannel(ctx, message)) return;

  // An in-progress verification code typed anywhere is exempt, so a code isn't punished as caps etc.
  const challenge = getChallenge(ctx.db, guildId, message.author.id);
  if (
    challenge &&
    challenge.expiresAt >= Date.now() &&
    isCodeShaped(message.content.trim().toUpperCase(), challenge.code.length)
  ) {
    return;
  }

  // Content rules run on new and edited messages, killing the edit-bypass. Don't count the
  // reply-ping toward the mention limit, it's implicit not spam.
  const repliedTo = message.mentions.repliedUser;
  const replyPing = repliedTo && message.mentions.users.has(repliedTo.id) ? 1 : 0;
  const mentionCount = message.mentions.users.size + message.mentions.roles.size - replyPing;
  let violation = checkContent(
    message.content,
    { mentionCount, massMention: message.mentions.everyone },
    rules,
  );

  // Stateful rules only on new messages: an edit doesn't add to flood/duplicate history.
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
  const deleted = await deleteSuppressed(message.id, () => message.delete());
  if (!deleted) {
    // Couldn't remove it (no ManageMessages here, or it's already gone), don't record a warn,
    // escalate, or tell the user it was "removed" while it's still sitting in the channel.
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
        .send(`Your message in **${guild.name}** was removed by automod: ${label}.`)
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
    // MessageUpdate also fires for embed loads, pins, etc. Only re-scan when the CONTENT
    // actually changed, or we'd re-punish (and race the create-scan's delete) on every embed.
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;
    const msg = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (msg) await scan(ctx, msg, true);
  },
};

export const automodModule: BotModule = {
  name: "automod",
  listeners: [onCreate, onEdit, seedOnReady] as Listener[],
};
