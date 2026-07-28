import { EmbedBuilder, Events, type GuildMember, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { type GuardAction, parseGuardAction, strongerAction } from "../../lib/actions";
import { matchBlocklist, parseBlocklist } from "../../lib/guards";
import { applyModAction, autoWipeSeconds } from "../../lib/mod-action";
import { logModAlert } from "../../lib/modlog";

const DAY_MS = 86_400_000;

interface Signal {
  reason: string;
  action: GuardAction;
}

function actionOf(ctx: AppContext, guildId: string, key: string): GuardAction {
  return parseGuardAction(ctx.config.getEffective(guildId, key));
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
  const summary = reasons.join("; ");
  let effective = action;

  // Carry out a removal via the shared helper (gate + DM-before-removal + act). If it can't be
  // done — owner, a member above the bot, missing permission, or an API failure — downgrade to a
  // flag so the alert reports what actually happened, not just what we intended.
  if (effective === "kick" || effective === "ban") {
    const dm = ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.guardDmOnRemoval)
      ? `You were ${effective === "ban" ? "banned from" : "removed from"} **${guild.name}**: ${summary}.`
      : undefined;
    const acted = await applyModAction({
      guild,
      member,
      userId: member.id,
      type: effective,
      reason: `Guard: ${summary}`,
      dm,
      deleteMessageSeconds: effective === "ban" ? autoWipeSeconds(ctx, guild.id) : undefined,
    });
    if (!acted) effective = "flag";
  }

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
}

// One assessment per join: gather every tripped signal (age / no-avatar / bad name), then take
// the single strongest action with a consolidated alert.
// Staff and bots are never guarded — a moderator named "Mod" must not be auto-removed by the
// name guard, and bots are added deliberately by an admin.
function exempt(member: GuildMember): boolean {
  return member.user.bot || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    if (exempt(member)) return;
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
    if (exempt(newMember)) return;
    // An uncached member's "before" carries no nickname, so every unrelated update (roles,
    // avatar, timeout) would look like a rename and re-enforce against a name that hasn't
    // changed. Without a real prior nickname there is no edit to react to.
    if (oldMember.partial) return;
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
