import { describe, expect, it } from "vitest";
import { FailureRateLimiter } from "./rate-limit";

function limiterAt(start: number) {
  let now = start;
  const limiter = new FailureRateLimiter(3, 60_000, () => now);
  return { limiter, advance: (ms: number) => (now += ms) };
}

describe("FailureRateLimiter", () => {
  it("allows until the failure limit is reached", () => {
    const { limiter } = limiterAt(0);
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("k").allowed).toBe(true);
      limiter.recordFailure("k");
    }
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("frees up as old failures leave the window", () => {
    const { limiter, advance } = limiterAt(0);
    limiter.recordFailure("k");
    advance(30_000);
    limiter.recordFailure("k");
    limiter.recordFailure("k");
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterSeconds: 30 });
    advance(30_001);
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("keeps keys independent and supports reset", () => {
    const { limiter } = limiterAt(0);
    for (let i = 0; i < 3; i++) limiter.recordFailure("a");
    expect(limiter.check("b").allowed).toBe(true);
    limiter.reset("a");
    expect(limiter.check("a").allowed).toBe(true);
  });
});
