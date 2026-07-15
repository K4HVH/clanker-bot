// Pure guard logic: action ranking + name-blocklist parsing/matching. No Discord/config
// dependencies, so it can be unit-tested in isolation.

export type GuardAction = "off" | "flag" | "kick" | "ban";

export const GUARD_ACTIONS: { value: GuardAction; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "flag", label: "Flag (alert only)" },
  { value: "kick", label: "Kick" },
  { value: "ban", label: "Ban" },
];

const RANK: Record<GuardAction, number> = { off: 0, flag: 1, kick: 2, ban: 3 };

// The stronger of two actions (ban > kick > flag > off) — so several tripped signals collapse
// to the harshest one.
export function strongerAction(a: GuardAction, b: GuardAction): GuardAction {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface NamePattern {
  source: string; // the raw entry, shown in the alert
  test(name: string): boolean;
}

// Substrings shorter than this are too broad (e.g. "a" matches almost every name), so they're
// dropped. Use a /regex/ for a precise short match.
const MIN_SUBSTRING = 3;

function compileRegex(entry: string): NamePattern | null {
  // Lowercase flags only, so a stray uppercase letter can't build an invalid flag string.
  const m = entry.match(/^\/(.+)\/([a-z]*)$/);
  if (m?.[1] === undefined) return null;
  try {
    const flags = m[2]?.includes("i") ? m[2] : `${m[2] ?? ""}i`; // force case-insensitive
    const re = new RegExp(m[1], flags);
    return { source: entry, test: (name) => re.test(name) };
  } catch {
    return null; // invalid regex — skip it rather than break the whole guard
  }
}

function substringPattern(entry: string): NamePattern | null {
  if (entry.length < MIN_SUBSTRING) return null;
  const needle = entry.toLowerCase();
  return { source: entry, test: (name) => name.toLowerCase().includes(needle) };
}

// Parse a blocklist. Each LINE is one entry; a line wrapped in /slashes/ is a regex (forced
// case-insensitive) and is kept whole — so it may contain commas (e.g. /ab{1,3}/). A non-regex
// line is split on commas into case-insensitive substrings. Blanks, too-short substrings, and
// invalid regexes are skipped.
export function parseBlocklist(raw: string): NamePattern[] {
  const out: NamePattern[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\/.+\/[a-z]*$/.test(trimmed)) {
      const p = compileRegex(trimmed);
      if (p) out.push(p);
      continue;
    }
    for (const part of trimmed.split(",")) {
      const p = substringPattern(part.trim());
      if (p) out.push(p);
    }
  }
  return out;
}

// The first blocklist entry that any of the given names matches, or null.
export function matchBlocklist(
  patterns: NamePattern[],
  names: Array<string | null | undefined>,
): string | null {
  const candidates = names.filter((n): n is string => !!n);
  for (const p of patterns) {
    if (candidates.some((n) => p.test(n))) return p.source;
  }
  return null;
}
