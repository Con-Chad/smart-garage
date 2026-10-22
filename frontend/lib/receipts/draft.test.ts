import { describe, expect, it } from "vitest";
import { buildReceiptDraft, normalizeLocalDateTime } from "@/lib/receipts/draft";
import type { ModelReceipt } from "@/lib/receipts/extract";

const NOW = new Date("2026-10-22T10:00:00Z");

const usReceipt: ModelReceipt = {
  isFuelReceipt: true,
  stationName: "Shell",
  stationAddress: "123 Main St, Springfield",
  purchasedAt: "2026-10-20T14:32:00",
  volume: { value: 11.482, unit: "gal" },
  pricePerUnit: { value: 3.459, currency: "USD" },
  total: { value: 39.72, currency: "USD" },
  fuelGrade: "Regular 87",
  confidence: { volume: 0.98, total: 0.99, purchasedAt: 0.9, pricePerUnit: 0.95, stationName: 0.9 },
};

const build = (raw: ModelReceipt, fallbackCurrency: string | null = "EUR") =>
  buildReceiptDraft(raw, { fallbackCurrency, now: NOW });

describe("buildReceiptDraft", () => {
  it("converts US gallons and dollars to litres and integer cents", () => {
    const result = build(usReceipt);
    expect(result.isFuelReceipt).toBe(true);
    if (!result.isFuelReceipt) return;
    expect(result.warnings).toEqual([]);
    expect(result.draft).toMatchObject({
      filledAtLocal: "2026-10-20T14:32:00",
      liters: 43.464, // 11.482 × 3.785411784
      totalCostCents: 3972,
      currency: "USD",
      stationName: "Shell",
      stationAddress: "123 Main St, Springfield",
      fuelGrade: "Regular 87",
      confidence: { filledAtLocal: 0.9, liters: 0.98, totalCostCents: 0.99, stationName: 0.9 },
    });
    // 3.459 $/gal → 345.9 ¢/gal → ¢/L, 3 decimals
    expect(result.draft.pricePerLiterCents).toBe(91.377);
    expect(result.draft.source.volume).toEqual({ value: 11.482, unit: "gal" });
  });

  it("keeps litres and euros as they are", () => {
    const result = build({
      ...usReceipt,
      stationName: "Aral",
      volume: { value: 41.23, unit: "l" },
      pricePerUnit: { value: 1.789, currency: "EUR" },
      total: { value: 73.76, currency: "EUR" },
    });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.liters).toBe(41.23);
    expect(result.draft.totalCostCents).toBe(7376);
    expect(result.draft.pricePerLiterCents).toBe(178.9);
    expect(result.warnings).toEqual([]);
  });

  it("converts imperial gallons", () => {
    const result = build({ ...usReceipt, volume: { value: 10, unit: "imp_gal" }, pricePerUnit: null, total: null });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.liters).toBe(45.461);
  });

  it("lowers confidence and warns when volume × price is off by more than 2 %", () => {
    const result = build({ ...usReceipt, total: { value: 45.0, currency: "USD" } });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.warnings).toContain("total_mismatch");
    expect(result.draft.confidence.liters).toBe(0.5);
    expect(result.draft.confidence.totalCostCents).toBe(0.5);
    expect(result.draft.totalCostCents).toBe(4500);
  });

  it("accepts a total within the 2 % tolerance (rounding on the receipt)", () => {
    // 11.482 × 3.459 = 39.716…; printed 39.72 — fine. Printed 40.40 is +1.7 %.
    const result = build({ ...usReceipt, total: { value: 40.4, currency: "USD" } });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.warnings).not.toContain("total_mismatch");
  });

  it("returns a distinct result for something that isn't a fuel receipt", () => {
    const result = build({ ...usReceipt, isFuelReceipt: false });
    expect(result).toEqual({ isFuelReceipt: false, draft: null, warnings: ["not_fuel_receipt"] });
  });

  it("falls back to the user's currency and says so", () => {
    const result = build({
      ...usReceipt,
      pricePerUnit: { value: 1.789, currency: null },
      total: { value: 73.76, currency: null },
    });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.currency).toBe("EUR");
    expect(result.warnings).toContain("currency_assumed");
  });

  it("flags conflicting currencies but keeps the total's", () => {
    const result = build({ ...usReceipt, pricePerUnit: { value: 3.459, currency: "CAD" } });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.currency).toBe("USD");
    expect(result.warnings).toContain("currency_conflict");
  });

  it("drops implausible values and zeroes their confidence", () => {
    const result = build({
      ...usReceipt,
      volume: { value: 900, unit: "l" },
      total: { value: 0, currency: "USD" },
      stationName: null,
    });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.liters).toBeNull();
    expect(result.draft.totalCostCents).toBeNull();
    // The unit price is still reported (litres here), the implausible volume isn't.
    expect(result.draft.pricePerLiterCents).toBe(345.9);
    expect(result.draft.confidence).toMatchObject({ liters: 0, totalCostCents: 0, stationName: 0 });
    expect(result.warnings).toEqual(expect.arrayContaining(["volume_implausible", "total_implausible"]));
  });

  it("derives the price per litre when the receipt only shows volume and total", () => {
    const result = build({ ...usReceipt, pricePerUnit: null, volume: { value: 40, unit: "l" }, total: { value: 72, currency: "EUR" } });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.pricePerLiterCents).toBe(180);
  });

  it("warns about missing fields", () => {
    const result = build({ ...usReceipt, volume: null, total: null, pricePerUnit: null, purchasedAt: null });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.warnings).toEqual(expect.arrayContaining(["volume_missing", "total_missing", "date_missing"]));
    expect(result.draft.filledAtLocal).toBeNull();
    expect(result.draft.confidence.filledAtLocal).toBe(0);
    expect(result.draft.pricePerLiterCents).toBeNull();
  });

  it("uses noon for a date without a time and halves its confidence", () => {
    const result = build({ ...usReceipt, purchasedAt: "2026-10-20" });
    if (!result.isFuelReceipt) throw new Error("expected a draft");
    expect(result.draft.filledAtLocal).toBe("2026-10-20T12:00:00");
    expect(result.draft.confidence.filledAtLocal).toBe(0.5);
    expect(result.warnings).toContain("time_missing");
  });
});

describe("normalizeLocalDateTime", () => {
  it("accepts date-time with or without seconds", () => {
    expect(normalizeLocalDateTime("2026-10-20T14:32", NOW)).toEqual({ value: "2026-10-20T14:32:00", warning: null });
    expect(normalizeLocalDateTime("2026-10-20 14:32:05", NOW)).toEqual({ value: "2026-10-20T14:32:05", warning: null });
  });

  it("rejects malformed and impossible dates", () => {
    expect(normalizeLocalDateTime("20.10.2026", NOW)).toEqual({ value: null, warning: "date_unreadable" });
    expect(normalizeLocalDateTime("2026-02-30T10:00:00", NOW)).toEqual({ value: null, warning: "date_unreadable" });
    expect(normalizeLocalDateTime("2026-10-20T25:00:00", NOW)).toEqual({ value: null, warning: "date_unreadable" });
  });

  it("keeps but flags dates in the future", () => {
    expect(normalizeLocalDateTime("2026-11-05T09:00:00", NOW)).toEqual({ value: "2026-11-05T09:00:00", warning: "date_in_future" });
    // A day of slack for the phone's timezone.
    expect(normalizeLocalDateTime("2026-10-23T08:00:00", NOW).warning).toBeNull();
  });
});
