export class HeatTracker {
  private readonly events = new Map<string, number[]>();

  // Returns true when the count in the window exceeds maxMessages. Window and
  // threshold are passed per call so they can be config-driven per guild.
  record(
    guildId: string,
    userId: string,
    now: number,
    windowMs: number,
    maxMessages: number,
  ): boolean {
    const key = `${guildId}:${userId}`;
    const recent = (this.events.get(key) ?? []).filter((t) => t > now - windowMs);
    recent.push(now);
    this.events.set(key, recent);
    if (this.events.size > 1000) {
      for (const [k, ts] of this.events) if (ts.every((t) => t <= now - windowMs)) this.events.delete(k);
    }
    return recent.length > maxMessages;
  }

  forget(key: string): void {
    this.events.delete(key);
  }
}

// Levenshtein edit distance. Inputs are capped by the caller (SprayTracker caps at 300 chars),
// so the O(m·n) table stays small.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

// Percentage similarity of two strings (100 = identical), normalized by the longer length.
function similarityPct(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return (1 - levenshtein(a, b) / maxLen) * 100;
}

interface SprayEntry {
  channelId: string;
  text: string; // normalized (trimmed, lowercased, capped)
  fp: string | null; // attachment fingerprint "size:w:h", or null
  ts: number;
}

// True when two entries are "the same spray": an identical attachment fingerprint, or (when both
// carry enough text) near-identical text. Short text can only match via the fingerprint.
function spraysMatch(a: SprayEntry, b: SprayEntry, minChars: number, similarity: number): boolean {
  if (a.fp && b.fp && a.fp === b.fp) return true;
  if (a.text.length > 0 && a.text.length >= minChars && b.text.length >= minChars) {
    return similarityPct(a.text, b.text) >= similarity;
  }
  return false;
}

// Detects a hijacked account spraying near-identical content across many channels: the shape
// automod's flood/duplicate rules miss (they're per-window and blind to image-only posts). Keyed
// per user; records EVERY message including image-only ones (unlike RepeatTracker). Returns true
// when the current message matches enough distinct channels within the window.
export class SprayTracker {
  private readonly seen = new Map<string, SprayEntry[]>();

  record(
    key: string,
    entry: { channelId: string; text: string; fp: string | null; now: number },
    opts: { windowMs: number; minChars: number; similarity: number; channels: number },
  ): boolean {
    const cur: SprayEntry = {
      channelId: entry.channelId,
      text: entry.text.trim().toLowerCase().slice(0, 300),
      fp: entry.fp,
      ts: entry.now,
    };
    const recent = (this.seen.get(key) ?? []).filter((e) => e.ts > entry.now - opts.windowMs);
    recent.push(cur);
    this.seen.set(key, recent);
    if (this.seen.size > 1000) {
      for (const [k, es] of this.seen) {
        if (es.every((e) => e.ts <= entry.now - opts.windowMs)) this.seen.delete(k);
      }
    }

    const channels = new Set<string>();
    for (const e of recent) {
      if (spraysMatch(cur, e, opts.minChars, opts.similarity)) channels.add(e.channelId);
    }
    return channels.size >= opts.channels;
  }

  forget(key: string): void {
    this.seen.delete(key);
  }
}

// Tracks recent message contents per key; returns true when a message duplicates one the
// same key already sent within the window (spam via copy-paste).
export class RepeatTracker {
  private readonly seen = new Map<string, { content: string; ts: number }[]>();

  record(key: string, content: string, now: number, windowMs: number): boolean {
    const norm = content.trim().toLowerCase();
    if (!norm) return false;
    const recent = (this.seen.get(key) ?? []).filter((e) => e.ts > now - windowMs);
    const dup = recent.some((e) => e.content === norm);
    recent.push({ content: norm, ts: now });
    this.seen.set(key, recent);
    if (this.seen.size > 1000) {
      for (const [k, es] of this.seen) if (es.every((e) => e.ts <= now - windowMs)) this.seen.delete(k);
    }
    return dup;
  }

  forget(key: string): void {
    this.seen.delete(key);
  }
}
