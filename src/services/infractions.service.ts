export const STRIKE_WEIGHTS: Record<string, number> = {
  note: 0,
  warn: 1,
  timeout: 2,
  kick: 3,
  ban: 0,
  unban: 0,
};

// Sum of weights for cases still within the decay window.
export function computeActiveScore(
  cases: { type: string; createdAt: number }[],
  now: number,
  decayDays: number,
): number {
  const cutoff = now - decayDays * 86_400_000;
  let score = 0;
  for (const c of cases) {
    if (c.createdAt >= cutoff) score += STRIKE_WEIGHTS[c.type] ?? 0;
  }
  return score;
}
