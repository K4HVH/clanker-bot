// A short-lived per-key claim, used to collapse a burst of the same user's messages into one
// action. Claim a key synchronously before the first await in a handler; the first caller wins and
// the rest bail. Entries self-expire after ttlMs and are pruned once the map grows past `max`.
export class Claims {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 500,
  ) {}

  claim(key: string, now: number = Date.now()): boolean {
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.ttlMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > this.max) {
      const cutoff = now - this.ttlMs;
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
    }
    return true;
  }
}
