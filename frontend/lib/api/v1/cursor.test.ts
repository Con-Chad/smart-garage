import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  listCursorSchema,
  parseLimit,
  parseSince,
  syncCursorSchema,
} from "@/lib/api/v1/cursor";

describe("API cursors", () => {
  const schema = z.object({ i: z.string(), n: z.number() });

  it("round-trips through an opaque URL-safe string", () => {
    const cursor = encodeCursor({ i: "abc/+=", n: 3 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, schema)).toEqual({ i: "abc/+=", n: 3 });
  });

  it("rejects garbage and wrong shapes instead of throwing", () => {
    expect(decodeCursor("not base64 json", schema)).toBeNull();
    expect(decodeCursor(encodeCursor({ i: 1 }), schema)).toBeNull();
  });

  it("rejects tampered timestamps in sync cursors instead of passing Invalid Date to the database (S-4)", () => {
    const valid = { v: 1, s: null, t: "2026-10-22T03:00:00.000Z", f: false, e: 0, u: null, i: null };
    expect(decodeCursor(encodeCursor(valid), syncCursorSchema)).toEqual(valid);
    expect(
      decodeCursor(encodeCursor({ ...valid, s: "2026-10-21T00:00:00.000Z", u: "2026-10-21T12:00:00.000Z", i: "abc" }), syncCursorSchema),
    ).not.toBeNull();

    for (const tampered of [
      { ...valid, t: "x" },
      { ...valid, t: "" },
      { ...valid, s: "garbage" },
      { ...valid, u: "not a date", i: "abc" },
      { ...valid, t: 1_700_000_000_000 },
      { ...valid, i: "" },
      { ...valid, e: -1 },
    ]) {
      expect(decodeCursor(encodeCursor(tampered), syncCursorSchema), JSON.stringify(tampered)).toBeNull();
    }
  });

  it("requires list cursor sort values to match their type tag", () => {
    expect(decodeCursor(encodeCursor({ v: "2026-10-22T03:00:00.000Z", d: true, i: "a" }), listCursorSchema)).not.toBeNull();
    expect(decodeCursor(encodeCursor({ v: 7, d: false, i: "a" }), listCursorSchema)).not.toBeNull();
    expect(decodeCursor(encodeCursor({ v: "garbage", d: true, i: "a" }), listCursorSchema)).toBeNull();
    expect(decodeCursor(encodeCursor({ v: 7, d: true, i: "a" }), listCursorSchema)).toBeNull();
    expect(decodeCursor(encodeCursor({ v: "7", d: false, i: "a" }), listCursorSchema)).toBeNull();
    expect(decodeCursor(encodeCursor({ v: 7, d: false, i: "" }), listCursorSchema)).toBeNull();
  });

  it("clamps limits", () => {
    expect(parseLimit(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("0")).toBe(DEFAULT_PAGE_SIZE);
    expect(parseLimit("2.5")).toBe(DEFAULT_PAGE_SIZE);
    expect(parseLimit("100000")).toBe(MAX_PAGE_SIZE);
  });

  it("parses since as an ISO timestamp", () => {
    expect(parseSince(null)).toBeNull();
    expect(parseSince("2026-10-20T12:00:00.000Z")?.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(() => parseSince("yesterday")).toThrow();
  });
});
