import { type Guild, type GuildMember, PermissionFlagsBits } from "discord.js";
import type { AppContext } from "../core/context";
import { CONFIG_KEYS } from "./config";

// How many seconds of a user's messages to wipe when the bot bans them automatically. One setting
// (Moderation → Auto-ban wipe) shared by guards, automod, the honeypot, and anti-scam, so every
// automated ban wipes consistently. Discord caps deleteMessageSeconds at 604800 (7 days = 168h).
export function autobanWipeSeconds(ctx: AppContext, guildId: string): number {
  return ctx.config.getEffective<number>(guildId, CONFIG_KEYS.autobanDeleteHours) * 3600;
}

// The single "can the bot carry out this removal?" gate, shared by automod escalation, join
// guards, and the honeypot. Pure + numeric so it can be exhaustively unit-tested without
// discord.js. The bot must be in the guild (mePos), the target must be resolvable (targetPos),
// must not be the owner, must sit strictly below the bot's top role, and the bot must hold the
// relevant permission. Callers reach this through applyModAction below rather than gating inline.
export function canAct(opts: {
  mePos: number | null;
  meHasPerm: boolean;
  targetPos: number | null;
  userId: string;
  ownerId: string;
}): boolean {
  const { mePos, meHasPerm, targetPos, userId, ownerId } = opts;
  if (mePos === null || targetPos === null) return false;
  if (userId === ownerId) return false;
  if (targetPos >= mePos) return false;
  return meHasPerm;
}

export interface ModActionInput {
  guild: Guild;
  member: GuildMember | null; // null => not resolvable; the gate then fails (no ban-by-id here)
  userId: string;
  type: "timeout" | "kick" | "ban";
  reason: string; // clipped to 500 for the audit reason
  deleteMessageSeconds?: number; // ban only; Discord hard cap 604_800 (7 days)
  timeoutMs?: number; // timeout only
  dm?: string; // if set, DM the user (before removal for ban/kick, after for timeout)
}

// Carry out one moderation action, applying the shared permission/hierarchy gate and the correct
// DM ordering. Returns true iff the Discord action actually landed. NEVER throws and NEVER logs —
// each caller owns its own record-keeping (automod writes a case, guards writes an alert, the
// honeypot writes both), so logging is deliberately left out.
export async function applyModAction(input: ModActionInput): Promise<boolean> {
  const { guild, member, userId, type } = input;
  const me = guild.members.me;
  const perm =
    type === "ban"
      ? PermissionFlagsBits.BanMembers
      : type === "kick"
        ? PermissionFlagsBits.KickMembers
        : PermissionFlagsBits.ModerateMembers;
  const allowed = canAct({
    mePos: me?.roles.highest.position ?? null,
    meHasPerm: !!me?.permissions.has(perm),
    targetPos: member?.roles.highest.position ?? null,
    userId,
    ownerId: guild.ownerId,
  });
  if (!allowed) return false;

  const reason = input.reason.slice(0, 500);
  const notify = async () => {
    if (input.dm) await member?.send(input.dm).catch(() => {});
  };

  try {
    if (type === "ban") {
      await notify(); // DM BEFORE removal — no shared guild afterwards
      await guild.members.ban(userId, { reason, deleteMessageSeconds: input.deleteMessageSeconds });
    } else if (type === "kick") {
      await notify();
      await member?.kick(reason);
    } else {
      await member?.timeout(input.timeoutMs ?? 0, reason);
      await notify(); // still in the guild — DM after, so it only sends on success
    }
  } catch {
    return false;
  }
  return true;
}
