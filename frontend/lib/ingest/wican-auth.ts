import { createHash, timingSafeEqual } from "node:crypto";

// Separate from wican.ts, which instrumentation.ts imports: that file is also
// compiled for the Edge runtime, where node:crypto is not available.

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of `Authorization: Bearer <token>`; false when no token is configured. */
export function isWicanAuthorized(header: string | null, token: string | null): boolean {
  if (!token || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(sha256(match[1].trim()), sha256(token));
}
