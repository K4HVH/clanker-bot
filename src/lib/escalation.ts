import type { Guild, GuildMember } from "discord.js";
import type { AppContext } from "../core/context";
import { createCase, listCasesByUser } from "../db/cases";
import { CONFIG_KEYS } from "./config";
import { computeActiveScore, strikeWeightsFrom } from "./infractions";
import { logCase } from "./modlog";

export interface EscalationAction {
  type: "timeout" | "kick" | "ban";
  durationMs?: number;
}

export interface EscalationThresholds {
  shortScore: number;
  longScore: number;
  kickScore: number;
  banScore: number;
  shortMs: number;
  longMs: number;
}

export function escalationActionFor(
  score: number,
  t: EscalationThresholds,
): EscalationAction | null {
  if (score >= t.banScore) return { type: "ban" };
  if (score >= t.kickScore) return { type: "kick" };
  if (score >= t.longScore) return { type: "timeout", durationMs: t.longMs };
  if (score >= t.shortScore) return { type: "timeout", durationMs: t.shortMs };
  return null;
}

function thresholdsFrom(ctx: AppContext, guildId: string): EscalationThresholds {
  const g = (key: string) => ctx.config.getEffective<number>(guildId, key);
  return {
    shortScore: g(CONFIG_KEYS.escalationTimeoutShortScore),
    longScore: g(CONFIG_KEYS.escalationTimeoutLongScore),
    kickScore: g(CONFIG_KEYS.escalationKickScore),
    banScore: g(CONFIG_KEYS.escalationBanScore),
    shortMs: g(CONFIG_KEYS.escalationTimeoutShortMs),
    longMs: g(CONFIG_KEYS.escalationTimeoutLongMs),
  };
}

export async function applyEscalation(
  ctx: AppContext,
  guild: Guild,
  targetUserId: string,
): Promise<void> {
  if (!ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.autoEscalation)) return;

  const decayDays = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.strikeDecayDays);
  const cases = listCasesByUser(ctx.db, guild.id, targetUserId, 100);
  const score = computeActiveScore(
    cases,
    Date.now(),
    decayDays,
    strikeWeightsFrom(ctx.config, guild.id),
  );
  const action = escalationActionFor(score, thresholdsFrom(ctx, guild.id));
  if (!action) return;

  const botMember = await guild.members.fetchMe();
  if (targetUserId === guild.ownerId || targetUserId === botMember.id) return;

  let member: GuildMember | undefined;
  try {
    member = await guild.members.fetch(targetUserId);
  } catch {
    member = undefined;
  }
  if (member && member.roles.highest.position >= botMember.roles.highest.position) return;

  const reason = `Auto-escalation at strike score ${score}`;
  try {
    if (action.type === "ban") {
      await guild.members.ban(targetUserId, { reason });
    } else if (member && action.type === "kick") {
      await member.kick(reason);
    } else if (member && action.type === "timeout") {
      await member.timeout(action.durationMs ?? null, reason);
    } else {
      return; // kick/timeout require a present member
    }
  } catch (error) {
    ctx.logger.error("escalation action failed", {
      targetUserId,
      type: action.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const record = createCase(ctx.db, {
    guildId: guild.id,
    userId: targetUserId,
    moderatorId: botMember.id,
    type: action.type,
    reason,
    meta: { auto: true },
  });
  await logCase(ctx, guild, record);
}
