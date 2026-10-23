import { describe, expect, it } from "vitest";
import { buildServiceReceiptDraft, type ScheduleForMatching } from "@/lib/receipts/service-draft";
import type { ModelServiceReceipt } from "@/lib/receipts/service-extract";
import { workshopReceipt } from "@/test/fixtures/service-receipt";

const NOW = new Date("2026-10-22T10:00:00Z");
const schedules: ScheduleForMatching[] = [
  { id: "sched-oil", templateSlug: "oil_change", name: "Engine oil & filter" },
  { id: "sched-custom", templateSlug: null, name: "Detailing" },
];

const build = (raw: ModelServiceReceipt, fallbackCurrency: string | null = "USD", list = schedules) =>
  buildServiceReceiptDraft(raw, { fallbackCurrency, schedules: list, now: NOW });

describe("buildServiceReceiptDraft", () => {
  it("builds a record draft in stored units matched to the vehicle's schedules", () => {
    const result = build(workshopReceipt);
    expect(result.isServiceReceipt).toBe(true);
    if (!result.isServiceReceipt) return;
    expect(result.warnings).toEqual([]);
    const { draft } = result;
    expect(draft).toMatchObject({
      performedAtLocal: "2026-10-15T12:00:00",
      odometerKm: 48210,
      vendorName: "Autohaus Müller",
      invoiceNumber: "R-2026-1042",
      expenseCategory: "MAINTENANCE",
      suggestedTarget: "record",
      suggestedScheduleId: "sched-oil",
      labourCents: 12000,
      partsCents: 7700,
      taxCents: 3743,
      totalCostCents: 23443,
      currency: "EUR",
      confidence: { performedAtLocal: 0.9, odometerKm: 0.95, totalCostCents: 0.98, vendorName: 0.9, serviceTypes: 0.85 },
    });
    expect(draft.serviceTypes).toEqual([
      { templateSlug: "oil_change", name: "Engine oil & filter", category: "ENGINE", scheduleId: "sched-oil", confidence: 0.95 },
      { templateSlug: "cabin_filter", name: "Cabin / pollen filter", category: "FILTERS", scheduleId: null, confidence: 0.8 },
    ]);
    expect(draft.items).toEqual([
      {
        category: "ENGINE_OIL",
        name: "Motoröl 5W-30",
        brand: "Castrol",
        partNumber: null,
        quantity: 4.5,
        unit: "LITERS",
        customUnit: null,
        costCents: 6210,
        currency: "EUR",
      },
      {
        category: "OIL_FILTER",
        name: "Ölfilter",
        brand: "Mann",
        partNumber: "HU 6004 x",
        quantity: 1,
        unit: "PIECES",
        customUnit: null,
        costCents: 1490,
        currency: "EUR",
      },
    ]);
    expect(draft.otherLines).toEqual([{ kind: "labour", description: "Arbeitslohn Inspektion", amountCents: 12000 }]);
    expect(draft.note).toBe("Invoice R-2026-1042\nArbeitslohn Inspektion: 120.00 EUR\nBremsbeläge hinten bei 3 mm");
  });

  it("converts miles to km", () => {
    const result = build({ ...workshopReceipt, odometer: { value: 30000, unit: "mi" } });
    if (!result.isServiceReceipt) throw new Error("expected a draft");
    expect(result.draft.odometerKm).toBe(48280);
    expect(result.draft.source.odometer).toEqual({ value: 30000, unit: "mi" });
  });

  it("sends fuel receipts and non-vehicle photos back without a draft", () => {
    expect(build({ ...workshopReceipt, isFuelReceipt: true })).toEqual({
      isServiceReceipt: false,
      draft: null,
      warnings: ["fuel_receipt"],
    });
    expect(build({ ...workshopReceipt, isVehicleReceipt: false })).toEqual({
      isServiceReceipt: false,
      draft: null,
      warnings: ["not_service_receipt"],
    });
  });

  it("flags a cost breakdown that doesn't add up and lowers the total's confidence", () => {
    const result = build({ ...workshopReceipt, labour: 500 });
    if (!result.isServiceReceipt) throw new Error("expected a draft");
    expect(result.warnings).toContain("cost_breakdown_mismatch");
    expect(result.draft.confidence.totalCostCents).toBe(0.5);
  });

  it("accepts gross subtotals that add up without tax", () => {
    const result = build({ ...workshopReceipt, labour: 142.8, parts: 91.63 });
    if (!result.isServiceReceipt) throw new Error("expected a draft");
    expect(result.warnings).not.toContain("cost_breakdown_mismatch");
  });

  it("falls back to the user's currency and reports missing or implausible values", () => {
    const result = build({
      ...workshopReceipt,
      currency: null,
      total: null,
      serviceDate: "2026-02-30",
      odometer: { value: -5, unit: "km" },
    });
    if (!result.isServiceReceipt) throw new Error("expected a draft");
    expect(result.draft.currency).toBe("USD");
    expect(result.draft.totalCostCents).toBeNull();
    expect(result.draft.performedAtLocal).toBeNull();
    expect(result.draft.odometerKm).toBeNull();
    expect(result.draft.confidence).toMatchObject({ totalCostCents: 0, performedAtLocal: 0, odometerKm: 0 });
    expect(result.warnings).toEqual(
      expect.arrayContaining(["currency_assumed", "total_missing", "date_unreadable", "odometer_implausible"]),
    );
  });

  it("warns when the work matches no schedule or no service type", () => {
    const noSchedule = build(workshopReceipt, "EUR", []);
    if (!noSchedule.isServiceReceipt) throw new Error("expected a draft");
    expect(noSchedule.draft.suggestedScheduleId).toBeNull();
    expect(noSchedule.warnings).toContain("no_matching_schedule");

    const unknown = build({ ...workshopReceipt, expenseCategory: "REPAIR", serviceTypes: [] });
    if (!unknown.isServiceReceipt) throw new Error("expected a draft");
    expect(unknown.draft.suggestedTarget).toBe("record");
    expect(unknown.draft.confidence.serviceTypes).toBe(0);
    expect(unknown.warnings).toContain("service_type_unknown");
  });

  it("suggests an expense for non-maintenance bills", () => {
    const result = build({
      ...workshopReceipt,
      expenseCategory: "INSURANCE",
      serviceTypes: [],
      lineItems: [],
      labour: null,
      parts: null,
      tax: null,
      invoiceNumber: null,
      notes: null,
    });
    if (!result.isServiceReceipt) throw new Error("expected a draft");
    expect(result.draft).toMatchObject({
      expenseCategory: "INSURANCE",
      suggestedTarget: "expense",
      suggestedScheduleId: null,
      items: [],
      note: null,
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps discounts negative and drops out-of-range item amounts", () => {
    const result = build({
      ...workshopReceipt,
      lineItems: [
        { ...workshopReceipt.lineItems[1], total: 2_000_000 },
        { ...workshopReceipt.lineItems[2], kind: "discount", description: "Rabatt", total: -10 },
      ],
    });
    if (!result.isServiceReceipt) throw new Error("expected a draft");
    expect(result.draft.items[0].costCents).toBeNull();
    expect(result.draft.otherLines).toEqual([{ kind: "discount", description: "Rabatt", amountCents: -1000 }]);
  });
});
