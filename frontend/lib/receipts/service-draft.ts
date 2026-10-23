import type { MaintenanceCategory, MaintenanceItemUnit } from "@prisma/client";
import { MAINTENANCE_TEMPLATE_SEEDS } from "@/lib/maintenance/templates-data";
import { normalizeLocalDateTime, TOTAL_TOLERANCE } from "@/lib/receipts/draft";
import { LINE_UNITS, type ModelServiceReceipt, SERVICE_EXPENSE_CATEGORIES } from "@/lib/receipts/service-extract";

/**
 * Turns the model's service-receipt JSON into a **draft** maintenance record
 * / expense in stored units (km, integer cents), matched against the
 * vehicle's maintenance schedules (D-044). Pure: no database access; the
 * caller passes the schedules in. Nothing is written; the app saves the
 * confirmed values with `POST /api/v1/records` or `POST /api/v1/expenses`.
 */

/** Hard limits mirrored from `recordCreateSchema` / `maintenanceItemSchema`. */
const MAX_TOTAL_CENTS = 1_000_000_000;
const MAX_ITEM_CENTS = 100_000_000;
const MAX_KM = 10_000_000;
const MAX_ITEMS = 40;
export const KM_PER_MILE = 1.609344;

export type ServiceReceiptWarning =
  | "not_service_receipt"
  | "fuel_receipt"
  | "total_missing"
  | "total_implausible"
  | "date_missing"
  | "date_unreadable"
  | "date_in_future"
  | "odometer_implausible"
  | "currency_assumed"
  | "cost_breakdown_mismatch"
  | "service_type_unknown"
  | "no_matching_schedule"
  | "items_truncated";

export type ScheduleForMatching = {
  id: string;
  templateSlug: string | null;
  name: string;
};

export type ServiceExpenseCategory = (typeof SERVICE_EXPENSE_CATEGORIES)[number];

export type ServiceTypeMatch = {
  templateSlug: string;
  /** English template name, for display. */
  name: string;
  category: MaintenanceCategory;
  /** The vehicle's active schedule for this template, or null (the app may offer to create one). */
  scheduleId: string | null;
  confidence: number;
};

export type ServiceDraftItem = {
  category: string;
  name: string;
  brand: string | null;
  partNumber: string | null;
  quantity: number | null;
  unit: MaintenanceItemUnit | null;
  customUnit: string | null;
  costCents: number | null;
  currency: string | null;
};

export type ServiceDraftLine = {
  kind: "labour" | "fee" | "discount" | "other";
  description: string;
  /** Integer cents, negative for discounts. */
  amountCents: number | null;
};

export type ServiceReceiptDraft = {
  /** Local date (and time) on the receipt, `YYYY-MM-DDTHH:MM:SS`, no zone; noon when only a date is printed. */
  performedAtLocal: string | null;
  odometerKm: number | null;
  vendorName: string | null;
  vendorAddress: string | null;
  invoiceNumber: string | null;
  expenseCategory: ServiceExpenseCategory;
  /** "record" when this looks like maintenance/repair work, else "expense". */
  suggestedTarget: "record" | "expense";
  serviceTypes: ServiceTypeMatch[];
  suggestedScheduleId: string | null;
  /** Parts and fluids, shaped for `items` in `POST /api/v1/records`. */
  items: ServiceDraftItem[];
  /** Labour, fees, discounts and unclassified lines (no column of their own). */
  otherLines: ServiceDraftLine[];
  labourCents: number | null;
  partsCents: number | null;
  taxCents: number | null;
  totalCostCents: number | null;
  currency: string | null;
  /** Ready-made note text (invoice number, labour/fee lines, advisories); null when empty. */
  note: string | null;
  confidence: {
    performedAtLocal: number;
    odometerKm: number;
    totalCostCents: number;
    vendorName: number;
    serviceTypes: number;
  };
  source: {
    odometer: { value: number; unit: "km" | "mi" } | null;
    total: number | null;
  };
};

export type ServiceReceiptScanResult =
  | { isServiceReceipt: true; draft: ServiceReceiptDraft; warnings: ServiceReceiptWarning[] }
  | { isServiceReceipt: false; draft: null; warnings: ServiceReceiptWarning[] };

export type BuildServiceDraftOptions = {
  fallbackCurrency: string | null;
  /** The vehicle's active schedules. */
  schedules: ScheduleForMatching[];
  now?: Date;
};

const UNIT_MAP: Record<(typeof LINE_UNITS)[number], MaintenanceItemUnit> = {
  l: "LITERS",
  ml: "MILLILITERS",
  qt: "QUARTS",
  gal: "GALLONS",
  fl_oz: "FLUID_OUNCES",
  pcs: "PIECES",
  set: "SETS",
  kg: "KG",
  g: "GRAMS",
  lb: "POUNDS",
  oz: "OUNCES",
};

const clamp01 = (value: number | undefined) =>
  value == null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));

/** Currency units → integer cents, or null when not finite / out of range. */
function toCents(value: number | null, max: number, allowNegative = false): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(cents) > max) return null;
  if (!allowNegative && cents < 0) return null;
  return cents;
}

export function buildServiceReceiptDraft(
  raw: ModelServiceReceipt,
  options: BuildServiceDraftOptions,
): ServiceReceiptScanResult {
  if (raw.isFuelReceipt) {
    return { isServiceReceipt: false, draft: null, warnings: ["fuel_receipt"] };
  }
  if (!raw.isVehicleReceipt) {
    return { isServiceReceipt: false, draft: null, warnings: ["not_service_receipt"] };
  }

  const warnings: ServiceReceiptWarning[] = [];
  const warn = (code: ServiceReceiptWarning) => {
    if (!warnings.includes(code)) warnings.push(code);
  };

  const confidence = {
    performedAtLocal: clamp01(raw.confidence.serviceDate),
    odometerKm: clamp01(raw.confidence.odometer),
    totalCostCents: clamp01(raw.confidence.total),
    vendorName: clamp01(raw.confidence.vendorName),
    serviceTypes: clamp01(raw.confidence.serviceTypes),
  };

  // Currency: the receipt's, else the user's preference.
  let currency = raw.currency;
  if (!currency && options.fallbackCurrency) {
    currency = options.fallbackCurrency;
    warn("currency_assumed");
  }

  // Total.
  let totalCostCents: number | null = null;
  if (raw.total != null) {
    const cents = toCents(raw.total, MAX_TOTAL_CENTS);
    if (cents != null && cents > 0) totalCostCents = cents;
    else warn("total_implausible");
  } else {
    warn("total_missing");
  }
  const labourCents = toCents(raw.labour, MAX_TOTAL_CENTS);
  const partsCents = toCents(raw.parts, MAX_TOTAL_CENTS);
  const taxCents = toCents(raw.tax, MAX_TOTAL_CENTS);

  // labour + parts (+ tax, when net subtotals are printed) ≈ total.
  if (totalCostCents && labourCents != null && partsCents != null) {
    const net = labourCents + partsCents;
    const close = (sum: number) => Math.abs(sum - totalCostCents) / totalCostCents <= TOTAL_TOLERANCE;
    if (!close(net) && !close(net + (taxCents ?? 0))) {
      warn("cost_breakdown_mismatch");
      confidence.totalCostCents = Math.min(confidence.totalCostCents, 0.5);
    }
  }

  // Odometer → km.
  let odometerKm: number | null = null;
  if (raw.odometer) {
    const km = Math.round(raw.odometer.unit === "mi" ? raw.odometer.value * KM_PER_MILE : raw.odometer.value);
    if (km > 0 && km <= MAX_KM) odometerKm = km;
    else warn("odometer_implausible");
  }

  // Date, kept local. Service invoices rarely print a time, so noon without a warning.
  const performed = normalizeLocalDateTime(raw.serviceDate, options.now ?? new Date());
  if (performed.warning && performed.warning !== "time_missing") {
    warn(performed.warning as ServiceReceiptWarning);
  }
  if (performed.value == null) confidence.performedAtLocal = 0;
  else if (performed.warning === "date_in_future") {
    confidence.performedAtLocal = Math.min(confidence.performedAtLocal, 0.5);
  }

  // Service types → the vehicle's schedules.
  const bySlug = new Map<string, ScheduleForMatching>();
  for (const schedule of options.schedules) {
    if (schedule.templateSlug && !bySlug.has(schedule.templateSlug)) bySlug.set(schedule.templateSlug, schedule);
  }
  const seen = new Set<string>();
  const serviceTypes: ServiceTypeMatch[] = [];
  for (const entry of raw.serviceTypes) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    const template = MAINTENANCE_TEMPLATE_SEEDS.find((t) => t.slug === entry.slug);
    if (!template) continue;
    serviceTypes.push({
      templateSlug: template.slug,
      name: template.nameEn,
      category: template.category,
      scheduleId: bySlug.get(template.slug)?.id ?? null,
      confidence: clamp01(entry.confidence),
    });
  }
  serviceTypes.sort((a, b) => b.confidence - a.confidence);
  const matched = serviceTypes.filter((s) => s.scheduleId);
  const suggestedScheduleId = matched[0]?.scheduleId ?? null;

  const expenseCategory: ServiceExpenseCategory =
    raw.expenseCategory ?? (serviceTypes.length > 0 ? "MAINTENANCE" : "OTHER");
  const suggestedTarget =
    expenseCategory === "MAINTENANCE" || expenseCategory === "REPAIR" || serviceTypes.length > 0 ? "record" : "expense";

  if (suggestedTarget === "record") {
    if (serviceTypes.length === 0) warn("service_type_unknown");
    else if (!suggestedScheduleId) warn("no_matching_schedule");
  }
  if (serviceTypes.length === 0) confidence.serviceTypes = 0;

  // Lines → items (parts/fluids) and other lines.
  const items: ServiceDraftItem[] = [];
  const otherLines: ServiceDraftLine[] = [];
  for (const line of raw.lineItems) {
    const description = line.description.trim();
    if (!description) continue;
    if (line.kind === "part" || line.kind === "fluid") {
      if (items.length >= MAX_ITEMS) {
        warn("items_truncated");
        continue;
      }
      items.push({
        category: line.itemCategory ?? "OTHER",
        name: description.slice(0, 120),
        brand: line.brand || null,
        partNumber: line.partNumber || null,
        quantity: line.quantity != null && line.quantity >= 0 && line.quantity <= 100_000 ? line.quantity : null,
        unit: line.unit ? UNIT_MAP[line.unit] : null,
        customUnit: null,
        costCents: toCents(line.total, MAX_ITEM_CENTS),
        currency,
      });
    } else {
      otherLines.push({
        kind: line.kind,
        description: description.slice(0, 200),
        amountCents: toCents(line.total, MAX_TOTAL_CENTS, true),
      });
    }
  }

  const vendorName = raw.vendorName || null;
  if (!vendorName) confidence.vendorName = 0;
  if (odometerKm == null) confidence.odometerKm = 0;
  if (totalCostCents == null) confidence.totalCostCents = 0;

  return {
    isServiceReceipt: true,
    warnings,
    draft: {
      performedAtLocal: performed.value,
      odometerKm,
      vendorName,
      vendorAddress: raw.vendorAddress || null,
      invoiceNumber: raw.invoiceNumber || null,
      expenseCategory,
      suggestedTarget,
      serviceTypes,
      suggestedScheduleId,
      items,
      otherLines,
      labourCents,
      partsCents,
      taxCents,
      totalCostCents,
      currency,
      note: buildNote(raw, otherLines, currency),
      confidence,
      source: { odometer: raw.odometer, total: raw.total },
    },
  };
}

function formatAmount(cents: number, currency: string | null): string {
  return `${(cents / 100).toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

/** At most 4000 characters, the record `note` limit (expense `description` is 500: the app trims). */
function buildNote(raw: ModelServiceReceipt, lines: ServiceDraftLine[], currency: string | null): string | null {
  const parts: string[] = [];
  if (raw.invoiceNumber) parts.push(`Invoice ${raw.invoiceNumber}`);
  for (const line of lines) {
    parts.push(line.amountCents != null ? `${line.description}: ${formatAmount(line.amountCents, currency)}` : line.description);
  }
  if (raw.notes) parts.push(raw.notes);
  const note = parts.join("\n").trim();
  return note ? note.slice(0, 4000) : null;
}
