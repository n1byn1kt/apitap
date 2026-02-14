// src/capture/idle.ts

/**
 * Tracks unique endpoint discoveries and detects idle periods.
 * Used during interactive capture to nudge the user when no new
 * endpoints have been found for a while.
 */
export class IdleTracker {
  private seen = new Set<string>();
  private lastNewTime: number;
  private thresholdMs: number;
  private fired = false;
  private now: () => number;

  constructor(thresholdMs = 15000, now: () => number = Date.now) {
    this.thresholdMs = thresholdMs;
    this.now = now;
    this.lastNewTime = this.now();
  }

  /**
   * Record an endpoint key (e.g. "GET /api/items").
   * Returns true if it's genuinely new (not seen before).
   */
  recordEndpoint(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.lastNewTime = this.now();
    this.fired = false;
    return true;
  }

  /**
   * Check if the idle threshold has been exceeded.
   * Returns true exactly once per idle period (until reset by a new endpoint).
   */
  checkIdle(): boolean {
    if (this.fired) return false;
    if (this.now() - this.lastNewTime >= this.thresholdMs) {
      this.fired = true;
      return true;
    }
    return false;
  }
}
