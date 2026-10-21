import { describe, expect, it } from "vitest";
import {
  deviceTokenDisplayPrefix,
  generateDeviceToken,
  hashDeviceToken,
  isWellFormedDeviceToken,
  parseBearerDeviceToken,
} from "./device-token";

describe("device tokens", () => {
  it("generates unique, well-formed tokens", () => {
    const a = generateDeviceToken();
    const b = generateDeviceToken();
    expect(a).not.toBe(b);
    expect(isWellFormedDeviceToken(a)).toBe(true);
    expect(a).toHaveLength(47);
  });

  it("rejects malformed tokens", () => {
    expect(isWellFormedDeviceToken(undefined)).toBe(false);
    expect(isWellFormedDeviceToken("sgd_short")).toBe(false);
    expect(isWellFormedDeviceToken(`xyz_${"a".repeat(43)}`)).toBe(false);
    expect(isWellFormedDeviceToken(`sgd_${"a".repeat(42)}!`)).toBe(false);
  });

  it("hashes deterministically without exposing the token", () => {
    const token = generateDeviceToken();
    expect(hashDeviceToken(token)).toBe(hashDeviceToken(token));
    expect(hashDeviceToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken(token)).not.toContain(token.slice(4));
  });

  it("shows only a short prefix", () => {
    const token = generateDeviceToken();
    expect(deviceTokenDisplayPrefix(token)).toBe(token.slice(0, 12));
  });

  it("parses Bearer headers", () => {
    const token = generateDeviceToken();
    expect(parseBearerDeviceToken(`Bearer ${token}`)).toBe(token);
    expect(parseBearerDeviceToken(`bearer  ${token}`)).toBe(token);
    expect(parseBearerDeviceToken(token)).toBeNull();
    expect(parseBearerDeviceToken("Bearer nope")).toBeNull();
    expect(parseBearerDeviceToken(null)).toBeNull();
  });
});
