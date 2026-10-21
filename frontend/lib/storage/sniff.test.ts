import { describe, expect, it } from "vitest";
import { contentMatchesMimeType, sniffMimeType } from "@/lib/storage/sniff";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniffMimeType", () => {
  it("recognizes every allowed upload type", () => {
    expect(sniffMimeType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe("image/jpeg");
    expect(sniffMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffMimeType(text("GIF89a...."))).toBe("image/gif");
    expect(sniffMimeType(text("RIFF\x10\x00\x00\x00WEBPVP8 "))).toBe("image/webp");
    expect(sniffMimeType(text("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMimeType(text("﻿\n%PDF-1.4"))).toBe("application/pdf");
  });

  it("rejects anything else, including look-alikes", () => {
    expect(sniffMimeType(text("MZ\x90\x00"))).toBeNull(); // Windows executable
    expect(sniffMimeType(text("<svg xmlns="))).toBeNull();
    expect(sniffMimeType(text("RIFF\x10\x00\x00\x00WAVEfmt "))).toBeNull();
    expect(sniffMimeType(bytes(0xff, 0xd8))).toBeNull(); // truncated
    expect(sniffMimeType(bytes())).toBeNull();
  });

  it("checks content against the declared type", () => {
    expect(contentMatchesMimeType(text("%PDF-1.4"), "application/pdf")).toBe(true);
    expect(contentMatchesMimeType(text("%PDF-1.4"), "image/png")).toBe(false);
  });
});
