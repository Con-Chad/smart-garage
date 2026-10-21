import { createHash, randomBytes } from "node:crypto";

/**
 * Bearer tokens for API devices (the mobile app). The `sgd_` prefix makes a
 * leaked token recognisable in logs and secret scanners, and lets the auth
 * path tell device tokens apart from anything else in an `Authorization`
 * header before touching the database.
 */
export const DEVICE_TOKEN_PREFIX = "sgd_";

/** 32 random bytes, base64url-encoded without padding = 43 characters. */
const DEVICE_TOKEN_RE = /^sgd_[A-Za-z0-9_-]{43}$/;

export function generateDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isWellFormedDeviceToken(value: unknown): value is string {
  return typeof value === "string" && DEVICE_TOKEN_RE.test(value);
}

/**
 * Tokens carry 256 bits of randomness, so a fast unsalted hash is enough —
 * there is nothing to brute-force, unlike a password.
 */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Short, non-secret label shown in the device list ("sgd_Ab12Cd34…"). */
export function deviceTokenDisplayPrefix(token: string): string {
  return token.slice(0, DEVICE_TOKEN_PREFIX.length + 8);
}

/** Extracts a well-formed device token from an `Authorization` header value. */
export function parseBearerDeviceToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return isWellFormedDeviceToken(token) ? token : null;
}
