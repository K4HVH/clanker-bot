import { HeatTracker } from "./heat";

export class RaidDetector {
  private readonly tracker = new HeatTracker();
  private readonly lastAlert = new Map<string, number>();

  // Returns true when a join spike is detected and an alert should fire.
  // Window/threshold/cooldown are passed per call so they can be config-driven.
  record(
    guildId: string,
    now: number,
    windowMs: number,
    threshold: number,
    cooldownMs: number,
  ): boolean {
    if (!this.tracker.record(guildId, "join", now, windowMs, threshold)) return false;
    const last = this.lastAlert.get(guildId) ?? 0;
    if (now - last < cooldownMs) return false;
    this.lastAlert.set(guildId, now);
    return true;
  }
}
