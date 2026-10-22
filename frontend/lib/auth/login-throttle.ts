import { FailureRateLimiter } from "@/lib/auth/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
/** Failed logins for one username from one address before it is locked out. */
const MAX_FAILURES_PER_ACCOUNT = 5;
/** Failed logins from one address across all usernames (password spraying). */
const MAX_FAILURES_PER_ADDRESS = 20;
/**
 * Failed logins for one username from *any* address. The client address comes
 * from headers a direct-to-origin caller can forge (see
 * `clientAddressFromHeaders`), so this is the limit that actually holds for
 * online guessing against a known account; the per-address limits only make a
 * well-behaved client's lockout narrower (S-2 in the 2026-10-22 audit).
 */
const MAX_FAILURES_PER_USERNAME = 30;

const globalForThrottle = globalThis as unknown as {
  loginThrottle?: {
    account: FailureRateLimiter;
    address: FailureRateLimiter;
    username: FailureRateLimiter;
  };
};

function newLimiters() {
  return {
    account: new FailureRateLimiter(MAX_FAILURES_PER_ACCOUNT, WINDOW_MS),
    address: new FailureRateLimiter(MAX_FAILURES_PER_ADDRESS, WINDOW_MS),
    username: new FailureRateLimiter(MAX_FAILURES_PER_USERNAME, WINDOW_MS),
  };
}

// Kept on globalThis so dev-server hot reloads don't reset the counters.
const limiters = (globalForThrottle.loginThrottle ??= newLimiters());

export class LoginRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("RATE_LIMITED");
  }
}

/**
 * Best-effort client address. Behind Cloudflare `CF-Connecting-IP` is set by
 * the edge; on the LAN the first `X-Forwarded-For` hop or the raw header is all
 * there is. Route handlers never see the socket address, so none of these can
 * be verified: a direct-to-origin caller can pick a fresh value per attempt.
 * The address therefore only *narrows* the lockout for honest clients; the
 * username-only limiter is what bounds guessing against one account.
 */
export function clientAddressFromHeaders(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

function usernameKey(username: string) {
  return username.trim().toLowerCase();
}

function accountKey(address: string, username: string) {
  return `${address}|${usernameKey(username)}`;
}

/** Throws `LoginRateLimitedError` when this address, account or username is locked out. */
export function assertLoginAllowed(address: string, username: string): void {
  for (const decision of [
    limiters.address.check(address),
    limiters.account.check(accountKey(address, username)),
    limiters.username.check(usernameKey(username)),
  ]) {
    if (!decision.allowed) throw new LoginRateLimitedError(decision.retryAfterSeconds);
  }
}

export function recordLoginFailure(address: string, username: string): void {
  limiters.address.recordFailure(address);
  limiters.account.recordFailure(accountKey(address, username));
  limiters.username.recordFailure(usernameKey(username));
}

/** A correct password clears the account's counters; the per-address spray counter stays. */
export function recordLoginSuccess(address: string, username: string): void {
  limiters.account.reset(accountKey(address, username));
  limiters.username.reset(usernameKey(username));
}

/** Test helper: forget all recorded failures. */
export function resetLoginThrottleForTests(): void {
  Object.assign(limiters, newLimiters());
}
