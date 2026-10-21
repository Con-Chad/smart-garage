import { z } from "zod";

/**
 * Opaque pagination cursors: base64url-encoded JSON. Clients must pass them
 * back unchanged; the shape may change between server versions.
 */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** `?limit=` clamped to 1..max; anything unparsable falls back to the default. */
export function parseLimit(
  raw: string | null,
  fallback = DEFAULT_PAGE_SIZE,
  max = MAX_PAGE_SIZE,
): number {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** `?since=` as a Date, or null when absent. Throws on a malformed value. */
export function parseSince(raw: string | null): Date | null {
  if (raw == null || raw === "") return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new InvalidQueryError("since must be an ISO 8601 timestamp");
  return date;
}

export class InvalidQueryError extends Error {}
