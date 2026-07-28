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

// A span of time as prose, for reading rather than re-entering as input (formatDuration's
// compact "3d" only survives round numbers). Keeps the two largest non-zero units, which is
// enough to judge a span without a wall of trailing precision. No months: their length
// varies, so any single figure for one would be a rounding fiction.
export function formatElapsed(ms: number): string {
  const units: [string, number][] = [
    ["year", 31_536_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  if (ms < 60_000) return "less than a minute";
  const parts: string[] = [];
  let rest = ms;
  for (const [label, size] of units) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  return parts.join(", ");
}
