import { describe, expect, it } from "vitest";
import { sanitizeOriginalFilename } from "./local";

describe("sanitizeOriginalFilename (S-9)", () => {
  it("keeps ordinary names as they are", () => {
    expect(sanitizeOriginalFilename("Rechnung 2026-10.pdf")).toBe("Rechnung 2026-10.pdf");
    expect(sanitizeOriginalFilename("übersicht ☕.jpg")).toBe("übersicht ☕.jpg");
  });

  it("strips control characters and trims", () => {
    expect(sanitizeOriginalFilename("  re\u0000ceipt\r\n.jpg\u007f ")).toBe("receipt.jpg");
  });

  it("caps the length at 255 characters", () => {
    expect(sanitizeOriginalFilename("a".repeat(10_000) + ".pdf")).toHaveLength(255);
  });

  it("falls back to a placeholder for empty or non-string names", () => {
    expect(sanitizeOriginalFilename("")).toBe("file");
    expect(sanitizeOriginalFilename("\u0001\u0002")).toBe("file");
    expect(sanitizeOriginalFilename(null)).toBe("file");
    expect(sanitizeOriginalFilename(undefined)).toBe("file");
    expect(sanitizeOriginalFilename(42)).toBe("42");
  });
});
