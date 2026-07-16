// Parsing + templating for the meme module's "@ the bot to do your bidding" feature. Kept pure
// so it's unit-testable without Discord objects.

export type MemeAction = "ban" | "unban" | "kick" | "timeout" | "untimeout" | "warn";

// Ordered so the reversals win before their base verb. Word boundaries already stop "unban" from
// matching \bban\b (the char before "ban" is a word char), but we list them first for clarity.
const PATTERNS: [RegExp, MemeAction][] = [
  [/\bunban\b/i, "unban"],
  [/\b(unmute|untimeout)\b/i, "untimeout"],
  [/\bban\b/i, "ban"],
  [/\bkick\b/i, "kick"],
  [/\b(timeout|mute)\b/i, "timeout"],
  [/\bwarn\b/i, "warn"],
];

// The moderation action named in a message, or null if none is present.
export function detectMemeAction(content: string): MemeAction | null {
  for (const [re, action] of PATTERNS) if (re.test(content)) return action;
  return null;
}

// Pull a duration token (e.g. "10m", "2 h") out of free text, normalized for parseDuration.
export function extractDuration(content: string): string | null {
  const m = content.match(/\b(\d+)\s*([smhdw])\b/i);
  return m ? `${m[1]}${(m[2] as string).toLowerCase()}` : null;
}

// The pool of reply lines: the user's configured lines (one per line, trimmed) or the fallbacks.
export function replyPool(raw: string | undefined, fallbacks: string[]): string[] {
  const lines = (raw ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines : fallbacks;
}

// Substitute {name} placeholders; unknown ones are left as-is so a typo is visible, not silent.
export function applyTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}
