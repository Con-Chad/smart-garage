import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseSince,
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
