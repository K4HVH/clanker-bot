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
}
