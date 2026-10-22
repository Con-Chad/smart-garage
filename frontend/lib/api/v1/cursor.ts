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

/**
 * Timestamps inside cursors must parse to a real date: `new Date("garbage")`
 * is an `Invalid Date`, which Prisma rejects with a thrown error (a 500)
 * rather than an empty result. Clients can edit cursors, so check here and
 * answer 400 `invalid_cursor` (S-4 in the 2026-10-22 audit).
 */
export const cursorTimestamp = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), { message: "Expected an ISO 8601 timestamp" });

/** `GET /api/v1/<collection>?cursor=`: sort value of the last item plus its id. */
export const listCursorSchema = z
  .object({
    // Sort value of the last item: an ISO date or a number, tagged so dates
    // round-trip as dates.
    v: z.union([z.string(), z.number()]),
    d: z.boolean(),
    i: z.string().min(1).max(64),
  })
  .refine(
    (cursor) =>
      cursor.d ? cursorTimestamp.safeParse(cursor.v).success : typeof cursor.v === "number",
    { message: "Sort value does not match its type tag" },
  );

/** `GET /api/v1/sync?cursor=`: where a sync session is and what it has emitted. */
export const syncCursorSchema = z.object({
  v: z.literal(1),
  /** Lower bound (ISO) or null for a full sync. */
  s: cursorTimestamp.nullable(),
  /** Session snapshot time (ISO). */
  t: cursorTimestamp,
  f: z.boolean(),
  /** Resource index and last (updatedAt, id) emitted within it. */
  e: z.number().int().min(0),
  u: cursorTimestamp.nullable(),
  i: z.string().min(1).max(64).nullable(),
});

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
