import { LITERS_PER_US_GALLON } from "@/lib/regional/volume";
import type { ModelReceipt } from "@/lib/receipts/extract";

/**
 * Turns the model's receipt JSON into a fill-up **draft** in stored units
 * (litres, integer cents), with per-field confidence and warnings. Pure:
 * nothing here touches the database, and nothing is written to `FuelEntry`;
 * the app shows the draft and the user saves it with `POST /api/v1/fuel`.
 */

/** Imperial gallon, conversion only; the UI never offers it (see lib/regional/volume.ts). */
export const LITERS_PER_IMPERIAL_GALLON = 4.54609;

/** Allowed deviation of volume × price from the printed total. */
export const TOTAL_TOLERANCE = 0.02;

/** Hard limits, mirrored from `fuelCreateSchema`; values beyond them are dropped. */
const MAX_LITERS = 500;
const MAX_TOTAL_CENTS = 1_000_000_000;

export type ReceiptWarning =
  | "not_fuel_receipt"
  | "volume_missing"
  | "total_missing"
  | "date_missing"
  | "time_missing"
  | "total_mismatch"
  | "currency_assumed"
  | "currency_conflict"
  | "volume_implausible"
  | "total_implausible"
  | "date_unreadable"
  | "date_in_future";

export type ReceiptDraft = {
  /** Local time printed on the receipt, `YYYY-MM-DDTHH:MM:SS`, no zone (the phone's zone applies). */
  filledAtLocal: string | null;
  /** Litres, at most 3 decimals. */
  liters: number | null;
  /** Integer cents of `currency`. */
  totalCostCents: number | null;
  /** ISO 4217; the user's preference when the receipt didn't say (`currency_assumed`). */
  currency: string | null;
  /** Cents per litre, informational, up to 3 decimals. */
  pricePerLiterCents: number | null;
  stationName: string | null;
  stationAddress: string | null;
  fuelGrade: string | null;
  /** 0–1 per draft field; 0 when the field is null. */
  confidence: {
    filledAtLocal: number;
    liters: number;
    totalCostCents: number;
    stationName: number;
  };
  /** The values as printed, before conversion, for the confirm screen. */
  source: {
    volume: { value: number; unit: "l" | "gal" | "imp_gal" } | null;
    pricePerUnit: { value: number; currency: string | null } | null;
    total: { value: number; currency: string | null } | null;
  };
};

export type ReceiptScanResult =
  | { isFuelReceipt: true; draft: ReceiptDraft; warnings: ReceiptWarning[] }
  | { isFuelReceipt: false; draft: null; warnings: ReceiptWarning[] };

export type BuildDraftOptions = {
  /** The user's preferred currency, used when the receipt doesn't name one. */
  fallbackCurrency: string | null;
  now?: Date;
};

export function litersPerUnit(unit: "l" | "gal" | "imp_gal"): number {
  switch (unit) {
    case "gal":
      return LITERS_PER_US_GALLON;
    case "imp_gal":
      return LITERS_PER_IMPERIAL_GALLON;
    default:
      return 1;
  }
}

const round = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const clamp01 = (value: number | undefined) =>
  value == null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));

export function buildReceiptDraft(raw: ModelReceipt, options: BuildDraftOptions): ReceiptScanResult {
  const warnings: ReceiptWarning[] = [];
  const warn = (code: ReceiptWarning) => {
    if (!warnings.includes(code)) warnings.push(code);
  };

  if (!raw.isFuelReceipt) {
    return { isFuelReceipt: false, draft: null, warnings: ["not_fuel_receipt"] };
  }

  const confidence = {
    filledAtLocal: clamp01(raw.confidence.purchasedAt),
    liters: clamp01(raw.confidence.volume),
    totalCostCents: clamp01(raw.confidence.total),
    stationName: clamp01(raw.confidence.stationName),
  };

  // Volume → litres.
  let liters: number | null = null;
  if (raw.volume) {
    const value = raw.volume.value * litersPerUnit(raw.volume.unit);
    if (value > 0 && value <= MAX_LITERS) {
      liters = round(value, 3);
    } else {
      warn("volume_implausible");
    }
  } else {
    warn("volume_missing");
  }

  // Total → integer cents.
  let totalCostCents: number | null = null;
  if (raw.total) {
    const cents = Math.round(raw.total.value * 100);
    if (cents > 0 && cents <= MAX_TOTAL_CENTS) {
      totalCostCents = cents;
    } else {
      warn("total_implausible");
    }
  } else {
    warn("total_missing");
  }

  // Currency: the total's, else the unit price's, else the user's preference.
  let currency: string | null = raw.total?.currency ?? raw.pricePerUnit?.currency ?? null;
  if (raw.total?.currency && raw.pricePerUnit?.currency && raw.total.currency !== raw.pricePerUnit.currency) {
    warn("currency_conflict");
  }
  if (!currency && options.fallbackCurrency) {
    currency = options.fallbackCurrency;
    warn("currency_assumed");
  }

  // Plausibility: volume × price ≈ total, as printed (same units on both sides).
  if (raw.volume && raw.pricePerUnit && raw.total && raw.total.value > 0) {
    const computed = raw.volume.value * raw.pricePerUnit.value;
    const deviation = Math.abs(computed - raw.total.value) / raw.total.value;
    if (deviation > TOTAL_TOLERANCE) {
      warn("total_mismatch");
      confidence.liters = Math.min(confidence.liters, 0.5);
      confidence.totalCostCents = Math.min(confidence.totalCostCents, 0.5);
    }
  }

  // Price per litre in cents, informational.
  let pricePerLiterCents: number | null = null;
  if (raw.pricePerUnit && raw.volume) {
    pricePerLiterCents = round((raw.pricePerUnit.value * 100) / litersPerUnit(raw.volume.unit), 3);
  } else if (liters && totalCostCents) {
    pricePerLiterCents = round(totalCostCents / liters, 3);
  }

  // Date and time, kept local.
  const filledAt = normalizeLocalDateTime(raw.purchasedAt, options.now ?? new Date());
  if (filledAt.warning) warn(filledAt.warning);
  if (filledAt.value == null) {
    confidence.filledAtLocal = 0;
  } else if (filledAt.warning) {
    confidence.filledAtLocal = Math.min(confidence.filledAtLocal, 0.5);
  }

  if (liters == null) confidence.liters = 0;
  if (totalCostCents == null) confidence.totalCostCents = 0;
  const stationName = raw.stationName || null;
  if (!stationName) confidence.stationName = 0;

  return {
    isFuelReceipt: true,
    warnings,
    draft: {
      filledAtLocal: filledAt.value,
      liters,
      totalCostCents,
      currency,
      pricePerLiterCents,
      stationName,
      stationAddress: raw.stationAddress || null,
      fuelGrade: raw.fuelGrade || null,
      confidence,
      source: {
        volume: raw.volume,
        pricePerUnit: raw.pricePerUnit,
        total: raw.total,
      },
    },
  };
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]` and returns
 * `YYYY-MM-DDTHH:MM:SS`. A date without a time becomes noon (`time_missing`)
 * so it lands on the right day in any timezone the phone applies.
 */
export function normalizeLocalDateTime(
  value: string | null,
  now: Date,
): { value: string | null; warning: ReceiptWarning | null } {
  if (!value) return { value: null, warning: "date_missing" };
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (!match) return { value: null, warning: "date_unreadable" };

  const [, y, mo, d, hh, mm, ss] = match;
  const hasTime = hh != null;
  const iso = `${y}-${mo}-${d}T${hasTime ? hh : "12"}:${hasTime ? mm : "00"}:${ss ?? "00"}`;

  // Validate the calendar date/time by round-tripping it as UTC.
  const probe = new Date(`${iso}Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 19) !== iso) {
    return { value: null, warning: "date_unreadable" };
  }
  // Receipts don't come from the future; allow a day of slack for timezones.
  if (probe.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    return { value: iso, warning: "date_in_future" };
  }
  return { value: iso, warning: hasTime ? null : "time_missing" };
}
