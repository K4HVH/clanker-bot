import type { AppContext } from "../../core/context";
import { CHECK_CATEGORIES, type CheckPolicy } from "../../lib/ticket-check";
import { CONFIG_KEYS, parseRoleIds } from "../../lib/config";

const K = CONFIG_KEYS;

// Read the guild's check settings. `required` is clamped to `questions` here rather than
// validated in the panel: they are two independent knobs, and "get 5 of 3 right" would be
// a gate nobody could pass.
export function readPolicy(ctx: AppContext, guildId: string): CheckPolicy {
  const cfg = ctx.config;
  const questions = cfg.getEffective<number>(guildId, K.ticketCheckQuestions);
  return {
    enabled: cfg.getEffective<boolean>(guildId, K.ticketCheckEnabled),
    categories: [...CHECK_CATEGORIES],
    questions,
    required: Math.min(cfg.getEffective<number>(guildId, K.ticketCheckRequired), questions),
    seconds: cfg.getEffective<number>(guildId, K.ticketCheckSeconds),
    passDays: cfg.getEffective<number>(guildId, K.ticketCheckPassDays),
    cooldownMinutes: cfg.getEffective<number>(guildId, K.ticketCheckCooldownMinutes),
    exemptStaff: cfg.getEffective<boolean>(guildId, K.ticketCheckExemptStaff),
    exemptRoles: parseRoleIds(cfg.getEffective<string>(guildId, K.ticketCheckExemptRoles)),
  };
}
