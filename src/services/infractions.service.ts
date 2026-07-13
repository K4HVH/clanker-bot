export const STRIKE_WEIGHTS: Record<string, number> = {
  note: 0,
  warn: 1,
  timeout: 2,
  kick: 3,
  ban: 0,
  unban: 0,
};

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
): number {
  const cutoff = now - decayDays * 86_400_000;
  let score = 0;
  for (const c of cases) {
    if (c.createdAt < cutoff) continue;
    if (isAutoCase(c.meta)) continue;
    score += STRIKE_WEIGHTS[c.type] ?? 0;
  }
  return score;
}
