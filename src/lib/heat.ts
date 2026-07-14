export class HeatTracker {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 7_000,
    private readonly maxMessages = 5,
  ) {}

  record(guildId: string, userId: string, now: number): boolean {
    const key = `${guildId}:${userId}`;
    const recent = (this.events.get(key) ?? []).filter((t) => t > now - this.windowMs);
    recent.push(now);
    this.events.set(key, recent);
    return recent.length > this.maxMessages;
  }
}
