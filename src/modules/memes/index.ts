import { Events, type Guild, type Message, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { type CaseType, createCase } from "../../db/cases";
import { CONFIG_KEYS } from "../../lib/config";
import { MAX_TIMEOUT_MS, parseDuration } from "../../lib/duration";
import { applyTemplate, detectMemeAction, extractDuration, type MemeAction, replyPool } from "../../lib/meme-command";
import { checkActionable } from "../../lib/moderation";
import { logCase } from "../../lib/modlog";

// Clean, funny defaults — the user can override every line in /config (and spice them up however
// they like). Placeholders: {mod} = requester, {target} = victim, {action} = the verb.
const DEFAULT_SUCCESS = [
  "Done. {target} has been dealt with. 🔨",
  "Say goodbye to {target}. 👋",
  "It is done, {mod}. 🫡",
  "{target} has left the building. You're welcome.",
];
const DEFAULT_DENIED = [
  "lol no. who do you think you are, {mod}?",
  "nice try {mod}, you don't have the clearance.",
  "and what exactly are you gonna do about it? sit down.",
  "absolutely not. go touch some grass.",
];
const DEFAULT_BLOCKED = [
  "yeah, I'm not touching {target}. above my pay grade.",
  "{target}'s got plot armor. can't do it.",
  "nope, that one's off-limits.",
];

const ACTION_META: Record<MemeAction, { perm: bigint; verb: string; caseType: CaseType }> = {
  ban: { perm: PermissionFlagsBits.BanMembers, verb: "banned", caseType: "ban" },
  unban: { perm: PermissionFlagsBits.BanMembers, verb: "unbanned", caseType: "unban" },
  kick: { perm: PermissionFlagsBits.KickMembers, verb: "kicked", caseType: "kick" },
  timeout: { perm: PermissionFlagsBits.ModerateMembers, verb: "timed out", caseType: "timeout" },
  untimeout: { perm: PermissionFlagsBits.ModerateMembers, verb: "un-muted", caseType: "untimeout" },
  warn: { perm: PermissionFlagsBits.ModerateMembers, verb: "warned", caseType: "warn" },
};

const MEME_TIMEOUT_DEFAULT_MS = 60 * 60_000; // "mute @user" with no duration → 1 hour

// Per-user cooldown so a non-mod can't spam-trigger the bot into a wall of snark.
const lastReply = new Map<string, number>();
const REPLY_COOLDOWN_MS = 4_000;

function dmText(action: MemeAction, guildName: string, reason: string): string {
  switch (action) {
    case "kick":
      return `You were kicked from **${guildName}**. Reason: ${reason}`;
    case "timeout":
      return `You were timed out in **${guildName}**. Reason: ${reason}`;
    case "untimeout":
      return `Your timeout in **${guildName}** was lifted. Reason: ${reason}`;
    case "warn":
      return `You were warned in **${guildName}**. Reason: ${reason}`;
    default:
      return `You were ${action} in **${guildName}**. Reason: ${reason}`;
  }
}

async function say(
  ctx: AppContext,
  guildId: string,
  message: Message,
  key: string,
  fallbacks: string[],
  vars: Record<string, string>,
): Promise<void> {
  const pool = replyPool(ctx.config.getEffective<string>(guildId, key), fallbacks);
  const choice = pool[Math.floor(Math.random() * pool.length)] ?? fallbacks[0] ?? "";
  // No pings: the mentions render as text so a snark can't be turned into a ping-spam vector.
  await message.reply({ content: applyTemplate(choice, vars), allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
}

async function quip(message: Message, text: string, vars: Record<string, string>): Promise<void> {
  await message.reply({ content: applyTemplate(text, vars), allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
}

async function handleMention(ctx: AppContext, message: Message): Promise<void> {
  if (!message.guild || message.author.bot || !message.content) return;
  const guild: Guild = message.guild;
  const guildId = guild.id;
  if (!ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.memesEnabled)) return;

  const botId = message.client.user.id;
  // Require an explicit in-content @mention of the bot (a reply-ping alone shouldn't trigger it).
  if (!new RegExp(`<@!?${botId}>`).test(message.content)) return;

  const action = detectMemeAction(message.content);
  if (!action) return; // mentioned with no recognized command — stay quiet

  const now = Date.now();
  if (now - (lastReply.get(message.author.id) ?? 0) < REPLY_COOLDOWN_MS) return;
  lastReply.set(message.author.id, now);
  if (lastReply.size > 1000) for (const [k, v] of lastReply) if (now - v > REPLY_COOLDOWN_MS) lastReply.delete(k);

  // Target: the first mentioned user that isn't the bot, else a raw id in the text (for unbanning
  // someone who isn't in the server to be mentioned).
  const mentioned = message.mentions.users.filter((u) => u.id !== botId).first();
  const rawId = (message.content.match(/\b\d{17,20}\b/g) ?? []).find((id) => id !== botId && id !== message.author.id);
  const targetId = mentioned?.id ?? rawId;
  const meta = ACTION_META[action];
  const vars: Record<string, string> = {
    mod: `<@${message.author.id}>`,
    target: targetId ? `<@${targetId}>` : "them",
    action: meta.verb,
  };

  if (!targetId) {
    await quip(message, "who? @ someone, {mod}.", vars);
    return;
  }

  // Permission gate — the whole point: obey those who have it, snark at those who don't.
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member || !member.permissions.has(meta.perm)) {
    await say(ctx, guildId, message, CONFIG_KEYS.memesDeniedReplies, DEFAULT_DENIED, vars);
    return;
  }

  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) return;
  const targetMember = await guild.members.fetch(targetId).catch(() => null);

  // Hierarchy / self / owner protection (same rules as the slash commands). Unban targets aren't
  // in the server, so it's exempt.
  if (action !== "unban") {
    const check = checkActionable({
      actorId: message.author.id,
      targetId,
      botId,
      guildOwnerId: guild.ownerId,
      actorHighestRole: member.roles.highest.position,
      targetHighestRole: targetMember?.roles.highest.position ?? -1,
      botHighestRole: botMember.roles.highest.position,
      targetIsMember: !!targetMember,
    });
    if (!check.ok) {
      await say(ctx, guildId, message, CONFIG_KEYS.memesBlockedReplies, DEFAULT_BLOCKED, vars);
      return;
    }
  }

  if ((action === "kick" || action === "timeout" || action === "untimeout" || action === "warn") && !targetMember) {
    await quip(message, "can't — {target} isn't even in the server.", vars);
    return;
  }

  const reason = `Requested by ${message.author.tag} via @mention`;
  const dmOn = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.dmOnAction);
  const targetUser = mentioned ?? targetMember?.user ?? (await message.client.users.fetch(targetId).catch(() => null));

  try {
    if (action === "ban") {
      if (dmOn && targetUser) await targetUser.send(`You were banned from **${guild.name}**. Reason: ${reason}`).catch(() => {});
      await guild.members.ban(targetId, { reason });
    } else if (action === "unban") {
      const ban = await guild.bans.fetch(targetId).catch(() => null);
      if (!ban) {
        await quip(message, "{target} isn't even banned.", vars);
        return;
      }
      await guild.members.unban(targetId, reason);
    } else if (action === "kick") {
      await targetMember?.kick(reason);
    } else if (action === "timeout") {
      const token = extractDuration(message.content);
      const ms = Math.min((token && parseDuration(token)) || MEME_TIMEOUT_DEFAULT_MS, MAX_TIMEOUT_MS);
      await targetMember?.timeout(ms, reason);
    } else if (action === "untimeout") {
      if ((targetMember?.communicationDisabledUntil?.getTime() ?? 0) <= Date.now()) {
        await quip(message, "{target} isn't muted.", vars);
        return;
      }
      await targetMember?.timeout(null, reason);
    }
    // warn has no Discord action. DM non-ban actions after they succeed (ban DM'd before removal).
    if (dmOn && targetUser && action !== "ban" && action !== "unban") {
      await targetUser.send(dmText(action, guild.name, reason)).catch(() => {});
    }
  } catch {
    await say(ctx, guildId, message, CONFIG_KEYS.memesBlockedReplies, DEFAULT_BLOCKED, vars);
    return;
  }

  await logCase(
    ctx,
    guild,
    createCase(ctx.db, { guildId, userId: targetId, moderatorId: message.author.id, type: meta.caseType, reason }),
  );
  await say(ctx, guildId, message, CONFIG_KEYS.memesSuccessReplies, DEFAULT_SUCCESS, vars);
}

const onMention: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    await handleMention(ctx, message);
  },
};

export const memesModule: BotModule = {
  name: "memes",
  listeners: [onMention] as Listener[],
};
