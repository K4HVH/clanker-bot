import { HeatTracker } from "./heat.service";

export class RaidDetector {
  private readonly tracker: HeatTracker;
  private readonly lastAlert = new Map<string, number>();

  constructor(
    windowMs = 10_000,
    threshold = 8,
    private readonly cooldownMs = 60_000,
  ) {
    this.tracker = new HeatTracker(windowMs, threshold);
  }

  // Returns true when a raid is detected and an alert should fire (cooldown-gated).
  record(guildId: string, now: number): boolean {
    if (!this.tracker.record(guildId, "join", now)) return false;
    const last = this.lastAlert.get(guildId) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.lastAlert.set(guildId, now);
    return true;
  }
}
