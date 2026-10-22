import { BodyType, DriveType, ExpenseCategory, FuelType, MaintenanceCategory } from "@prisma/client";
import { z } from "zod";
import { maintenanceItemsArraySchema } from "@/lib/validations/maintenance-items";
import { isValidTimezone } from "@/lib/settings/instance-defaults";

/**
 * Request bodies for `/api/v1` writes. Everything is in stored units: km,
 * liters, integer cents, ISO 8601 dates. Entities whose validation already
 * lives in a service (inspections, insurance, wishlist, custom fields,
 * modifications, sharing) are passed through and validated there.
 */

const id = z.string().min(1).max(64);
const isoDate = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: "Expected an ISO 8601 date",
});
const cents = z.number().int().min(0).max(1_000_000_000);
const km = z.number().int().min(0).max(10_000_000);
const currency = z.string().length(3);
const text = (max: number) => z.string().max(max);

export const fuelCreateSchema = z.object({
  vehicleId: id,
  filledAt: isoDate,
  odometerKm: km.nullable().optional(),
  liters: z.number().min(0).max(500).nullable().optional(),
  totalCostCents: cents,
  currency: currency.optional(),
  stationName: text(120).nullable().optional(),
  note: text(500).nullable().optional(),
  /** A RECEIPT document of the same vehicle (from `/fuel/receipt-scan`) to attach to the new entry. */
  receiptDocumentId: id.nullable().optional(),
});

export const expenseCreateSchema = z.object({
  vehicleId: id,
  category: z.nativeEnum(ExpenseCategory),
  occurredAt: isoDate,
  amountCents: cents,
  currency: currency.optional(),
  odometerKm: km.nullable().optional(),
  maintenanceRecordId: id.nullable().optional(),
  description: text(500).nullable().optional(),
});

export const odometerCreateSchema = z.object({
  vehicleId: id,
  odometerKm: km,
  recordedAt: isoDate.optional(),
  note: text(500).nullable().optional(),
});

const scheduleFields = {
  customName: text(120).optional(),
  category: z.nativeEnum(MaintenanceCategory).optional(),
  intervalKm: z.number().int().min(0).max(500_000).nullable().optional(),
  intervalMonths: z.number().int().min(0).max(120).nullable().optional(),
  estimatedCostCents: cents.nullable().optional(),
  currency: currency.optional(),
  notes: text(2000).optional(),
};

export const scheduleCreateSchema = z.object({
  vehicleId: id,
  templateId: id.optional(),
  ...scheduleFields,
});

export const schedulePatchSchema = z.object({
  ...scheduleFields,
  /** Baseline used until the schedule has real service records. */
  lastPerformedAt: isoDate.nullable().optional(),
  lastOdometerKm: km.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const itemDefaultsSchema = z.object({ items: maintenanceItemsArraySchema });

const recordFields = {
  performedAt: isoDate,
  odometerKm: km.nullable().optional(),
  costCents: cents.optional(),
  currency: currency.optional(),
  vendorName: text(120).nullable().optional(),
  note: text(4000).nullable().optional(),
  items: maintenanceItemsArraySchema.optional(),
  /** Also store these items as the schedule's default parts. */
  saveAsDefault: z.boolean().optional(),
};

export const recordCreateSchema = z.object({ scheduleId: id, ...recordFields });
export const recordPatchSchema = z.object(recordFields).partial();

export const noteFieldsSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().max(20000).optional(),
  vehicleId: id.nullable().optional(),
  maintenanceTemplateId: id.nullable().optional(),
  maintenanceRecordId: id.nullable().optional(),
  isPinned: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(8).optional(),
});
export const notePatchSchema = noteFieldsSchema.partial();

/** Manual entry only; catalog-based setup stays in the web UI. */
export const vehicleCreateSchema = z.object({
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  productionYear: z.number().int().min(1900).max(2100),
  currentOdometerKm: km,
  licensePlate: text(20).nullable().optional(),
  vin: text(17).nullable().optional(),
  hsn: text(4).nullable().optional(),
  tsn: text(3).nullable().optional(),
  color: text(50).nullable().optional(),
  notes: text(5000).nullable().optional(),
  fuelType: z.nativeEnum(FuelType).nullable().optional(),
  bodyType: z.nativeEnum(BodyType).nullable().optional(),
  driveType: z.nativeEnum(DriveType).nullable().optional(),
  powerKw: z.number().int().min(0).max(5000).nullable().optional(),
  powerPs: z.number().int().min(0).max(7000).nullable().optional(),
  torqueNm: z.number().int().min(0).max(20_000).nullable().optional(),
  displacementCc: z.number().int().min(0).max(50_000).nullable().optional(),
  engineDescription: text(200).nullable().optional(),
});

export const vehiclePatchSchema = z.object({
  licensePlate: text(20).nullable().optional(),
  vin: z
    .string()
    .trim()
    .regex(/^[A-HJ-NPR-Z0-9]{0,17}$/i, "Invalid VIN")
    .nullable()
    .optional(),
  hsn: z.string().trim().regex(/^\d{0,4}$/).nullable().optional(),
  tsn: z.string().trim().regex(/^[A-Z0-9]{0,3}$/i).nullable().optional(),
  color: text(50).nullable().optional(),
  notes: text(5000).nullable().optional(),
  purchaseDate: isoDate.nullable().optional(),
  purchasePriceCents: cents.nullable().optional(),
  purchaseCurrency: currency.nullable().optional(),
});

export const shareCreateSchema = z.object({ username: z.unknown(), role: z.unknown() });
export const sharePatchSchema = z.object({ role: z.unknown() });

export const customFieldValuesBodySchema = z.object({ values: z.unknown() });

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

/** Preferences the app may change; appearance settings stay web-only. */
export const preferencesPatchSchema = z.object({
  locale: z.enum(["en", "de"]).optional(),
  timezone: z.string().refine(isValidTimezone, { message: "Unknown IANA timezone" }).optional(),
  currency: z.enum(["EUR", "USD", "GBP", "CHF"]).optional(),
  distanceUnit: z.enum(["km", "mi"]).optional(),
  volumeUnit: z.enum(["l", "gal"]).optional(),
  maintenanceDueSoonKm: z.number().int().optional(),
  maintenanceDueSoonDays: z.number().int().optional(),
  quickFuelEnabled: z.boolean().optional(),
  hiddenVehicleFields: z.array(z.string()).optional(),
});

/** Notification preferences without credentials, which are set on the web only. */
export const notificationSettingsPatchSchema = z.object({
  pushoverEnabled: z.boolean().optional(),
  telegramEnabled: z.boolean().optional(),
  mobilePushEnabled: z.boolean().optional(),
  eventMaintenanceOverdue: z.boolean().optional(),
  eventMaintenanceDueSoon: z.boolean().optional(),
  eventMaintenanceLogged: z.boolean().optional(),
  eventExpenseAdded: z.boolean().optional(),
  eventOdometerReminder: z.boolean().optional(),
  odometerReminderDays: z.number().int().min(1).max(365).optional(),
  deliveryImmediate: z.boolean().optional(),
  deliveryScheduled: z.boolean().optional(),
  scheduledTime: hhmm.nullable().optional(),
  scheduledDays: z.string().max(64).nullable().optional(),
  minIntervalHours: z.number().int().min(0).max(168).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: hhmm.nullable().optional(),
  quietHoursEnd: hhmm.nullable().optional(),
  timezone: z.string().refine(isValidTimezone, { message: "Unknown IANA timezone" }).optional(),
});

/** `PUT /devices/{id}/push`: the subscription as the UnifiedPush/Web Push client reports it. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(128),
    auth: z.string().min(1).max(64),
  }),
});

/** Bodies passed through to a service that validates them itself. */
export const passthroughSchema = z.record(z.string(), z.unknown());
