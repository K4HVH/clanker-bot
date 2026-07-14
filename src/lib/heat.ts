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
    return recent.length > maxMessages;
  }
}
