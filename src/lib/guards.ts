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

// Parse a blocklist: comma/newline separated. An entry wrapped in /slashes/ is a regex
// (forced case-insensitive); anything else is a case-insensitive substring. Blank entries and
// invalid regexes are skipped rather than breaking the whole guard.
export function parseBlocklist(raw: string): NamePattern[] {
  const out: NamePattern[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const rx = entry.match(/^\/(.+)\/([a-z]*)$/i);
    if (rx?.[1] !== undefined) {
      try {
        const flags = rx[2]?.includes("i") ? rx[2] : `${rx[2] ?? ""}i`;
        const re = new RegExp(rx[1], flags);
        out.push({ source: entry, test: (name) => re.test(name) });
        continue;
      } catch {
        continue;
      }
    }
    const needle = entry.toLowerCase();
    out.push({ source: entry, test: (name) => name.toLowerCase().includes(needle) });
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
