// Pure name-blocklist parsing/matching (username/nickname guards + the automod word blocklist).
// No Discord/config dependencies, so it can be unit-tested in isolation. Action enums live in
// ./actions.

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
    return null; // invalid regex: skip it rather than break the whole guard
  }
}

function substringPattern(entry: string, wholeWord: boolean): NamePattern | null {
  if (entry.length < MIN_SUBSTRING) return null;
  if (wholeWord) {
    // Match only as a whole word, so a message filter doesn't flag "class" for "ass".
    const re = new RegExp(`\\b${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return { source: entry, test: (name) => re.test(name) };
  }
  const needle = entry.toLowerCase();
  return { source: entry, test: (name) => name.toLowerCase().includes(needle) };
}

// Parse a blocklist. Each LINE is one entry; a line wrapped in /slashes/ is a regex (forced
// case-insensitive) and is kept whole, so it may contain commas (e.g. /ab{1,3}/). A non-regex
// line is split on commas into case-insensitive terms. Blanks, too-short terms, and invalid
// regexes are skipped. `wholeWord` matches plain terms on word boundaries (for message
// filtering) instead of anywhere in the string (names).
export function parseBlocklist(raw: string, opts: { wholeWord?: boolean } = {}): NamePattern[] {
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
      const p = substringPattern(part.trim(), opts.wholeWord ?? false);
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
