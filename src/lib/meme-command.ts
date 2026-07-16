// Parsing + templating for the meme module's "@ the bot to do your bidding" feature. Kept pure
// so it's unit-testable without Discord objects.

export type MemeAction = "ban" | "unban" | "kick" | "timeout" | "untimeout" | "warn";

// The command verb is the FIRST word after the bot mention (`commandText`), not just any verb
// anywhere in the sentence. This keeps a stray keyword mid-sentence, or a negation ("don't ban"
// → first word "dont"), from firing a real moderation action. Reversals map to their base type.
export function detectMemeAction(commandText: string): MemeAction | null {
  const word = (commandText.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  switch (word) {
    case "unban":
      return "unban";
    case "unmute":
    case "untimeout":
      return "untimeout";
    case "ban":
      return "ban";
    case "kick":
      return "kick";
    case "timeout":
    case "mute":
      return "timeout";
    case "warn":
      return "warn";
    default:
      return null;
  }
}

// Pull a duration out of free text (e.g. "10m", "2 h", "10 minutes"), normalized for parseDuration.
export function extractDuration(content: string): string | null {
  const m = content.match(/\b(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|[smhdw])\b/i);
  return m ? `${m[1]}${(m[2] as string).charAt(0).toLowerCase()}` : null;
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
