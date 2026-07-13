import type { Guild, GuildMember } from "discord.js";
import type { AppContext } from "../core/context";
import { createCase, listCasesByUser } from "../repositories/cases.repository";
import { CONFIG_KEYS } from "./config.service";
import { computeActiveScore } from "./infractions.service";
import { logCase } from "./modlog.service";

export interface EscalationAction {
  type: "timeout" | "kick" | "ban";
  durationMs?: number;
}

export function escalationActionFor(score: number): EscalationAction | null {
  if (score >= 12) return { type: "ban" };
  if (score >= 8) return { type: "kick" };
  if (score >= 5) return { type: "timeout", durationMs: 86_400_000 };
  if (score >= 3) return { type: "timeout", durationMs: 3_600_000 };
  return null;
}

export async function applyEscalation(
  ctx: AppContext,
  guild: Guild,
  targetUserId: string,
): Promise<void> {
  if (!(ctx.config.get<boolean>(guild.id, CONFIG_KEYS.autoEscalation) ?? false)) return;

  const decayDays = ctx.config.get<number>(guild.id, CONFIG_KEYS.strikeDecayDays) ?? 90;
  const cases = listCasesByUser(ctx.db, guild.id, targetUserId, 100);
  const score = computeActiveScore(cases, Date.now(), decayDays);
  const action = escalationActionFor(score);
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
