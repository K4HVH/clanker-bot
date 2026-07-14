import { CONFIG_KEYS, type ConfigService } from "./config";

export const STRIKE_WEIGHTS: Record<string, number> = {
  note: 0,
  warn: 1,
  timeout: 2,
  kick: 3,
  ban: 0,
  unban: 0,
};

// Per-guild strike weights from config (ban/unban stay 0 — terminal actions).
export function strikeWeightsFrom(config: ConfigService, guildId: string): Record<string, number> {
  return {
    note: config.getEffective<number>(guildId, CONFIG_KEYS.strikeWeightNote),
    warn: config.getEffective<number>(guildId, CONFIG_KEYS.strikeWeightWarn),
    timeout: config.getEffective<number>(guildId, CONFIG_KEYS.strikeWeightTimeout),
    kick: config.getEffective<number>(guildId, CONFIG_KEYS.strikeWeightKick),
    ban: 0,
    unban: 0,
  };
}

function isAutoCase(meta?: string | null): boolean {
  if (!meta) return false;
  try {
    return (JSON.parse(meta) as { auto?: boolean }).auto === true;
  } catch {
    return false;
  }
}

// Sum of weights for non-auto cases still within the decay window.
export function computeActiveScore(
  cases: { type: string; createdAt: number; meta?: string | null }[],
  now: number,
  decayDays: number,
  weights: Record<string, number>,
): number {
  const cutoff = now - decayDays * 86_400_000;
  let score = 0;
  for (const c of cases) {
    if (c.createdAt < cutoff) continue;
    if (isAutoCase(c.meta)) continue;
    score += weights[c.type] ?? 0;
  }
  return score;
}
