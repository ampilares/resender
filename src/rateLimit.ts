/**
 * In-memory sliding-window rate limiter keyed by IP + form. Suitable for a
 * single-process, single-VPS deployment (the tool's target). Old timestamps are
 * pruned lazily on each check; a periodic sweep drops empty buckets.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    // Periodically drop stale buckets so memory does not grow unbounded.
    const timer = setInterval(() => this.sweep(), windowMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Record a hit and return true if it is allowed (within the limit). */
  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const bucket = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (bucket.length >= this.limit) {
      this.hits.set(key, bucket);
      return false;
    }
    bucket.push(now);
    this.hits.set(key, bucket);
    return true;
  }

  private sweep(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, bucket] of this.hits) {
      const live = bucket.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
}
