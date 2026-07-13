const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord's maximum timeout

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = (match[2] as string).toLowerCase();
  const ms = amount * (UNIT_MS[unit] ?? 0);
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  const units: [string, number][] = [
    ["w", 604_800_000],
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ];
  for (const [label, size] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${label}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
