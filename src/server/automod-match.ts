import type { AutoModSpec } from "./spec";

// A keyword AutoMod rule's match, as Discord applies it, for testing patterns and for listing old
// messages a rule would have blocked. Keywords: "*x*" anywhere, "x*" at a word's start, "*x" at its
// end, "x" a whole word, case-insensitive. Regexes run in JavaScript, which reads the subset the
// rules keep to (no lookaround, no backreferences, a leading (?i)) as Rust does.

function keywordHit(text: string, keyword: string): boolean {
  const core = keyword.replace(/^\*|\*$/g, "").toLowerCase();
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = keyword.startsWith("*") ? "" : "(?<![\\p{L}\\p{N}])";
  const end = keyword.endsWith("*") ? "" : "(?![\\p{L}\\p{N}])";
  return new RegExp(`${start}${escaped}${end}`, "u").test(text.toLowerCase());
}

export function ruleMatches(rule: AutoModSpec, text: string): boolean {
  if ((rule.allow ?? []).some((a) => keywordHit(text, a))) return false;
  if ((rule.keywords ?? []).some((k) => keywordHit(text, k))) return true;
  return (rule.regex ?? []).some((r) => {
    const insensitive = r.startsWith("(?i)");
    return new RegExp(insensitive ? r.slice(4) : r, insensitive ? "i" : "").test(text);
  });
}
