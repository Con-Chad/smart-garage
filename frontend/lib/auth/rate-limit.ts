/**
 * In-memory sliding-window failure counter.
 *
 * Smart Garage runs as a single container, so process memory is the right
 * scope: no extra table, nothing to clean up, and a restart simply forgets old
 * failures. Counting *failures* (not attempts) means a user who types their
 * password correctly is never slowed down.
 */
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class FailureRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitDecision {
    const recent = this.prune(key);
    if (recent.length < this.maxFailures) return { allowed: true };
    const oldest = recent[0]!;
    const retryAfterMs = oldest + this.windowMs - this.now();
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  recordFailure(key: string): void {
    const recent = this.prune(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  /** Forgets every key (tests). */
  clearAll(): void {
    this.failures.clear();
  }

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent;
  }
}
