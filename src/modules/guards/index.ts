import { EmbedBuilder, Events, type GuildMember, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { type GuardAction, matchBlocklist, parseBlocklist, strongerAction } from "../../lib/guards";
import { logModAlert } from "../../lib/modlog";

const DAY_MS = 86_400_000;

interface Signal {
  reason: string;
  action: GuardAction;
}

function actionOf(ctx: AppContext, guildId: string, key: string): GuardAction {
  const v = ctx.config.getEffective<string>(guildId, key);
  return v === "flag" || v === "kick" || v === "ban" ? v : "off";
}

function blocklistHit(ctx: AppContext, guildId: string, names: Array<string | null>): string | null {
  const raw = ctx.config.getEffective<string>(guildId, CONFIG_KEYS.nameBlocklist) ?? "";
  return matchBlocklist(parseBlocklist(raw), names);
}

// Carry out the strongest tripped action against a member, alerting the mod-log with the
// reasons. Downgrades a kick/ban to a flag (alert only) when it can't actually be carried out
// — the owner, a member above the bot, or a missing permission — so the alert never lies.
async function enforce(
  ctx: AppContext,
  member: GuildMember,
  action: GuardAction,
  reasons: string[],
): Promise<void> {
  if (action === "off") return;
  const guild = member.guild;
  let effective = action;
  if (effective === "kick" || effective === "ban") {
    const me = guild.members.me;
    const outranks =
      !!me && member.id !== guild.ownerId && member.roles.highest.position < me.roles.highest.position;
    const perm = effective === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
    if (!outranks || !me?.permissions.has(perm)) effective = "flag";
  }

  const summary = reasons.join("; ");
  await logModAlert(
    ctx,
    guild,
    new EmbedBuilder()
      .setColor(effective === "flag" ? 0xe67e22 : 0xe74c3c)
      .setTitle(
        effective === "flag" ? "🚩 Guard: flagged" : effective === "ban" ? "🔨 Guard: banned" : "👢 Guard: kicked",
      )
      .addFields(
        { name: "User", value: `<@${member.id}> (${member.id})` },
        { name: "Reason", value: summary.slice(0, 1024) },
      )
      .setTimestamp(new Date()),
  );

  if (effective === "flag") return;

  // DM before removal — afterwards we no longer share a guild to DM through.
  if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.guardDmOnRemoval)) {
    await member
      .send(`You were ${effective === "ban" ? "banned from" : "removed from"} **${guild.name}**: ${summary}.`)
      .catch(() => {});
  }
  const reason = `Guard: ${summary}`.slice(0, 500);
  if (effective === "ban") await member.ban({ reason }).catch(() => {});
  else await member.kick(reason).catch(() => {});
}

// One assessment per join: gather every tripped signal (age / no-avatar / bad name), then take
// the single strongest action with a consolidated alert.
const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    if (member.user.bot) return; // bots are added deliberately by an admin
    const gid = member.guild.id;
    const signals: Signal[] = [];

    const minDays = ctx.config.getEffective<number>(gid, CONFIG_KEYS.minAccountAgeDays);
    if (minDays > 0) {
      const ageMs = Date.now() - member.user.createdTimestamp;
      const ageAction = actionOf(ctx, gid, CONFIG_KEYS.accountAgeGateAction);
      if (ageMs < minDays * DAY_MS && ageAction !== "off") {
        signals.push({ reason: `account only ${Math.floor(ageMs / DAY_MS)}d old (min ${minDays}d)`, action: ageAction });
      }
    }

    if (ctx.config.getEffective<boolean>(gid, CONFIG_KEYS.flagNoAvatar) && !member.user.avatar) {
      signals.push({ reason: "no custom avatar", action: "flag" });
    }

    const nameAction = actionOf(ctx, gid, CONFIG_KEYS.nameGuardAction);
    if (nameAction !== "off") {
      const hit = blocklistHit(ctx, gid, [member.user.username, member.user.globalName, member.nickname]);
      if (hit) signals.push({ reason: `name matches \`${hit}\``, action: nameAction });
    }

    if (!signals.length) return;
    const action = signals.reduce<GuardAction>((acc, s) => strongerAction(acc, s.action), "off");
    await enforce(ctx, member, action, signals.map((s) => s.reason));
  },
};

// Re-run the name guard when a member renames themselves into a blocked pattern.
const onNickChange: Listener<Events.GuildMemberUpdate> = {
  event: Events.GuildMemberUpdate,
  async handle(ctx, oldMember, newMember) {
    if (newMember.user.bot) return;
    if (oldMember.nickname === newMember.nickname) return; // only nickname edits
    const gid = newMember.guild.id;
    const nameAction = actionOf(ctx, gid, CONFIG_KEYS.nameGuardAction);
    if (nameAction === "off") return;
    const hit = blocklistHit(ctx, gid, [newMember.nickname]);
    if (!hit) return;
    await enforce(ctx, newMember, nameAction, [`nickname matches \`${hit}\``]);
  },
};

export const guardsModule: BotModule = {
  name: "guards",
  listeners: [onJoin, onNickChange] as Listener[],
};
