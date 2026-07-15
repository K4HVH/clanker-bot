import { Events, type GuildMember, type Message, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { type CaseType, countAutomodViolations, createCase } from "../../db/cases";
import { getTicketByChannel } from "../../db/tickets";
import { getChallenge } from "../../db/verification";
import { checkContent, type ContentRules } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { HeatTracker, RepeatTracker } from "../../lib/heat";
import { suppressDeletion, suppressedDeletions } from "../../lib/log-suppress";
import { logCase } from "../../lib/modlog";
import { inVerifyChannel } from "../../lib/verify-channel";
import { isCodeShaped } from "../../lib/verification-logic";

const heat = new HeatTracker();
const repeats = new RepeatTracker();

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

// Escalate on accumulated violations within the memory window — applies the harshest crossed
// tier (ban > kick > timeout) and records it. Returns true if it acted. Won't touch the owner,
// a member above the bot, or act without the permission (the delete + warn still stand).
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

  const ttlMin = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodViolationTtlMinutes);
  const count = countAutomodViolations(ctx.db, guildId, userId, botId, Date.now() - ttlMin * 60_000);
  const banAt = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodBanAt);
  const kickAt = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodKickAt);
  const timeoutAt = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodTimeoutAt);

  let type: CaseType | null = null;
  if (banAt > 0 && count >= banAt) type = "ban";
  else if (kickAt > 0 && count >= kickAt) type = "kick";
  else if (timeoutAt > 0 && count >= timeoutAt) type = "timeout";
  if (!type) return false;

  // The target just sent a message, so they're a present member: require the bot to outrank
  // them (and not be the owner) and hold the permission — otherwise skip the escalation
  // silently (the delete + warn still stand). This avoids a doomed API call + a lying DM.
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

  // Act FIRST, then only DM/record on success — so a failed action never tells the user they
  // were punished. (A DM after a ban/kick silently no-ops since we no longer share a guild.)
  const reason = `Automod: ${count} violations in ${ttlMin}m`;
  try {
    if (type === "ban") await guild.members.ban(userId, { reason });
    else if (type === "kick") await member!.kick(reason);
    else {
      const mins = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodTimeoutMinutes);
      await member!.timeout(mins * 60_000, reason);
    }
  } catch {
    return false;
  }
  if (ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction)) {
    const verb = type === "ban" ? "banned from" : type === "kick" ? "kicked from" : "timed out in";
    await message.author.send(`You were ${verb} **${guild.name}** by automod — ${reason}.`).catch(() => {});
  }
  await logCase(ctx, guild, createCase(ctx.db, { guildId, userId, moderatorId: botId, type, reason }));
  return true;
}

async function scan(ctx: AppContext, message: Message, isEdit: boolean): Promise<void> {
  if (!message.guild || message.author.bot || !message.content) return;
  const guildId = message.guild.id;

  const rules = contentRulesFor(ctx, guildId);
  const flood = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodFlood);
  const duplicates = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodDuplicates);
  if (!anyRuleEnabled(rules, flood, duplicates)) return;

  // Exemptions: staff, the verify channel, ticket channels, and an in-progress verification
  // code typed elsewhere. Resolve the member so the staff check holds even on an edit where
  // message.member wasn't cached.
  const member =
    message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
  if (inVerifyChannel(ctx, message)) return;
  if (getTicketByChannel(ctx.db, message.channelId)) return;
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
  const warn = createCase(ctx.db, {
    guildId,
    userId: message.author.id,
    moderatorId: botId,
    type: "warn",
    reason: `Automod: ${violation}`,
  });
  await logCase(ctx, message.guild, warn);

  const escalated = await escalate(ctx, message, member, botId);
  if (!escalated && ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction)) {
    await message.author
      .send(`Your message in **${message.guild.name}** was removed by automod — ${violation}.`)
      .catch(() => {});
  }
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
