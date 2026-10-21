import { FailureRateLimiter } from "@/lib/auth/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
/** Failed logins for one username from one address before it is locked out. */
const MAX_FAILURES_PER_ACCOUNT = 5;
/** Failed logins from one address across all usernames (password spraying). */
const MAX_FAILURES_PER_ADDRESS = 20;

const globalForThrottle = globalThis as unknown as {
  loginThrottle?: { account: FailureRateLimiter; address: FailureRateLimiter };
};

// Kept on globalThis so dev-server hot reloads don't reset the counters.
const limiters = (globalForThrottle.loginThrottle ??= {
  account: new FailureRateLimiter(MAX_FAILURES_PER_ACCOUNT, WINDOW_MS),
  address: new FailureRateLimiter(MAX_FAILURES_PER_ADDRESS, WINDOW_MS),
});

export class LoginRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("RATE_LIMITED");
  }
}

/**
 * Best-effort client address. Behind Cloudflare `CF-Connecting-IP` is set by
 * the edge; on the LAN the first `X-Forwarded-For` hop or the raw header is all
 * there is. A spoofed header only lets an attacker spread their own failures
 * across buckets — the per-account limit still applies per address they use.
 */
export function clientAddressFromHeaders(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function accountKey(address: string, username: string) {
  return `${address}|${username.trim().toLowerCase()}`;
}

/** Throws `LoginRateLimitedError` when this address or account is locked out. */
export function assertLoginAllowed(address: string, username: string): void {
  for (const decision of [
    limiters.address.check(address),
    limiters.account.check(accountKey(address, username)),
  ]) {
    if (!decision.allowed) throw new LoginRateLimitedError(decision.retryAfterSeconds);
  }
}

export function recordLoginFailure(address: string, username: string): void {
  limiters.address.recordFailure(address);
  limiters.account.recordFailure(accountKey(address, username));
}

export function recordLoginSuccess(address: string, username: string): void {
  limiters.account.reset(accountKey(address, username));
}

/** Test helper: forget all recorded failures. */
export function resetLoginThrottleForTests(): void {
  limiters.account = new FailureRateLimiter(MAX_FAILURES_PER_ACCOUNT, WINDOW_MS);
  limiters.address = new FailureRateLimiter(MAX_FAILURES_PER_ADDRESS, WINDOW_MS);
}
