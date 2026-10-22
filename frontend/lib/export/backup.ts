import { randomUUID } from "node:crypto";
import path from "node:path";
import { DocumentCategory, DocumentPurpose, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { APP_VERSION } from "@/lib/app-version";
import {
  deleteStoredFile,
  extensionForMime,
  readStoredFile,
  restoreStoredFile,
  sanitizeOriginalFilename,
} from "@/lib/storage/local";
import { ALLOWED_DOCUMENT_MIME_TYPES } from "@/lib/storage/paths";
import { contentMatchesMimeType } from "@/lib/storage/sniff";

const BACKUP_FORMAT = "smart-garage-user-backup";
/**
 * Version 3 adds odometer logs and user-defined custom fields.
 *
 * Older backups stay restorable: a restore wipes and rebuilds the user's data,
 * so anything a v2 file does not carry simply comes back empty — which is
 * exactly what it was when the file was written.
 */
const BACKUP_SCHEMA_VERSION = 3;
const SUPPORTED_SCHEMA_VERSIONS = [2, 3];

type JsonRecord = Record<string, unknown>;

function stringifyBigInts<T>(value: T): T {
  if (typeof value === "bigint") return value.toString() as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (Array.isArray(value)) return value.map(stringifyBigInts) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stringifyBigInts(item)]),
    ) as T;
  }
  return value;
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function bigintOrNull(value: unknown): bigint | null {
  if (value == null || value === "") return null;
  return BigInt(String(value));
}

function bigintOrZero(value: unknown): bigint {
  return value == null || value === "" ? BigInt(0) : BigInt(String(value));
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function jsonOrUndefined(value: unknown): Prisma.InputJsonValue | undefined {
  return value == null ? undefined : (value as Prisma.InputJsonValue);
}

function invalidBackup(): never {
  throw new Error("INVALID_BACKUP");
}

/** Ids that end up in storage paths must be plain tokens (cuid/uuid shaped). */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function safeId(value: unknown): string {
  const id = String(value ?? "");
  if (!SAFE_ID_RE.test(id)) invalidBackup();
  return id;
}

/**
 * A backup may only reference rows it carries itself. Vehicles are re-created
 * under the importing user, so a child row naming any other vehicle id would
 * land on someone else's vehicle (the FK alone does not stop that).
 */
function assertOwnRef(value: unknown, own: Set<string>, options: { nullable?: boolean } = {}) {
  const ref = textOrNull(value);
  if (ref == null) {
    if (options.nullable) return;
    invalidBackup();
  }
  if (!own.has(ref)) invalidBackup();
}

function enumValue<T extends Record<string, string>>(values: T, value: unknown): T[keyof T] {
  const text = String(value);
  if (!Object.values(values).includes(text)) invalidBackup();
  return text as T[keyof T];
}

/** Everything a restored document row needs, with the storage key decided by the server. */
type PlannedDocument = {
  source: JsonRecord;
  vehicleId: string | null;
  purpose: DocumentPurpose;
  category: DocumentCategory | null;
  mimeType: string;
  storageKey: string;
  originalFilename: string;
  sizeBytes: bigint;
  file: Buffer | null;
};

function planDocument(
  userId: string,
  document: JsonRecord,
  own: { vehicles: Set<string>; records: Set<string>; expenses: Set<string>; fuelEntries: Set<string> },
): PlannedDocument {
  const vehicleId = textOrNull(document.vehicleId);
  assertOwnRef(vehicleId, own.vehicles, { nullable: true });
  assertOwnRef(document.maintenanceRecordId, own.records, { nullable: true });
  assertOwnRef(document.expenseId, own.expenses, { nullable: true });
  assertOwnRef(document.fuelEntryId, own.fuelEntries, { nullable: true });

  const purpose = enumValue(DocumentPurpose, document.purpose ?? "OTHER");
  const category = document.category == null ? null : enumValue(DocumentCategory, document.category);
  const mimeType = textOrNull(document.mimeType) ?? "application/octet-stream";

  // The file's own bytes decide whether it is restored, never the JSON's
  // declared type or key (D-043).
  let file: Buffer | null = null;
  if (typeof document.fileBase64 === "string") {
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(mimeType)) invalidBackup();
    file = Buffer.from(document.fileBase64, "base64");
    if (!contentMatchesMimeType(file, mimeType)) invalidBackup();
  }

  const filename = `${randomUUID()}${extensionForMime(mimeType) || ".bin"}`;
  const storageKey =
    vehicleId == null
      ? path.posix.join("users", userId, "documents", filename)
      : purpose === "VEHICLE_IMAGE"
        ? path.posix.join("vehicles", vehicleId, filename)
        : path.posix.join("vehicles", vehicleId, "documents", filename);

  return {
    source: document,
    vehicleId,
    purpose,
    category,
    mimeType,
    storageKey,
    originalFilename: sanitizeOriginalFilename(document.originalFilename),
    sizeBytes: file ? BigInt(file.length) : bigintOrZero(document.sizeBytes),
    file,
  };
}

/** A background key from the file is only kept when it is under this user's own folder. */
function ownBackgroundKey(userId: string, value: unknown): string | null {
  const key = textOrNull(value);
  if (!key || key.includes("..") || !key.startsWith(`users/${userId}/`)) return null;
  return key;
}

async function documentWithFile(document: {
  storageKey: string;
  [key: string]: unknown;
}) {
  try {
    const file = await readStoredFile(document.storageKey);
    return {
      ...document,
      fileBase64: file.toString("base64"),
    };
  } catch {
    return {
      ...document,
      fileBase64: null,
      fileMissing: true,
    };
  }
}

export async function buildUserExport(userId: string) {
  const [
    user,
    preferences,
    notificationSettings,
    vehicles,
    maintenanceRecords,
    expenses,
    fuelEntries,
    documents,
    noteTags,
    notes,
    wishlistItems,
    odometerLogs,
    customFields,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, email: true, displayName: true },
    }),
    prisma.userPreferences.findUnique({ where: { userId } }),
    prisma.userNotificationSettings.findUnique({ where: { userId } }),
    prisma.vehicle.findMany({
      where: { ownerUserId: userId, deletedAt: null },
      include: {
        factorySpecs: true,
        currentSpecs: true,
        modifications: true,
        maintenanceSchedules: { include: { itemDefaults: true } },
        inspections: true,
        insurancePolicies: true,
      },
    }),
    prisma.maintenanceRecord.findMany({
      where: { createdByUserId: userId },
      include: { items: true },
    }),
    prisma.expense.findMany({ where: { createdByUserId: userId } }),
    prisma.fuelEntry.findMany({ where: { createdByUserId: userId } }),
    prisma.document.findMany({
      where: {
        deletedAt: null,
        OR: [{ uploadedByUserId: userId }, { vehicle: { ownerUserId: userId } }],
      },
    }),
    prisma.noteTag.findMany({ where: { ownerUserId: userId } }),
    prisma.note.findMany({
      where: { ownerUserId: userId },
      include: { tags: { select: { id: true } } },
    }),
    prisma.wishlistItem.findMany({ where: { userId } }),
    // Restoring deletes the user's vehicles, which cascades to these two.
    // They must be in the file or a restore would silently drop them.
    prisma.odometerLog.findMany({ where: { vehicle: { ownerUserId: userId } } }),
    prisma.vehicleCustomField.findMany({
      where: { userId },
      include: { values: true },
    }),
  ]);

  const documentsWithFiles = await Promise.all(documents.map(documentWithFile));

  return stringifyBigInts({
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    user,
    preferences,
    notificationSettings,
    vehicles,
    maintenanceRecords,
    expenses,
    fuelEntries,
    documents: documentsWithFiles,
    noteTags,
    notes: notes.map((note) => ({
      ...note,
      tagIds: note.tags.map((tag) => tag.id),
      tags: undefined,
    })),
    wishlistItems,
    odometerLogs,
    customFields,
  });
}

export async function importUserBackup(userId: string, backup: unknown) {
  if (!backup || typeof backup !== "object") {
    throw new Error("INVALID_BACKUP");
  }

  const data = backup as JsonRecord;
  if (
    data.format !== BACKUP_FORMAT ||
    typeof data.schemaVersion !== "number" ||
    !SUPPORTED_SCHEMA_VERSIONS.includes(data.schemaVersion)
  ) {
    throw new Error("UNSUPPORTED_BACKUP");
  }

  const vehicles = Array.isArray(data.vehicles) ? (data.vehicles as JsonRecord[]) : [];
  const maintenanceRecords = Array.isArray(data.maintenanceRecords)
    ? (data.maintenanceRecords as JsonRecord[])
    : [];
  const expenses = Array.isArray(data.expenses) ? (data.expenses as JsonRecord[]) : [];
  const fuelEntries = Array.isArray(data.fuelEntries)
    ? (data.fuelEntries as JsonRecord[])
    : [];
  const documents = Array.isArray(data.documents) ? (data.documents as JsonRecord[]) : [];
  const noteTags = Array.isArray(data.noteTags) ? (data.noteTags as JsonRecord[]) : [];
  const notes = Array.isArray(data.notes) ? (data.notes as JsonRecord[]) : [];
  const wishlistItems = Array.isArray(data.wishlistItems)
    ? (data.wishlistItems as JsonRecord[])
    : [];
  // Absent in v2 backups — an empty list is the correct restore result there.
  const odometerLogs = Array.isArray(data.odometerLogs)
    ? (data.odometerLogs as JsonRecord[])
    : [];
  const customFields = Array.isArray(data.customFields)
    ? (data.customFields as JsonRecord[])
    : [];

  // Cross-check every reference before touching the database, so a bad file
  // is rejected whole and the user's existing data stays as it was.
  const own = {
    vehicles: new Set(vehicles.map((vehicle) => safeId(vehicle.id))),
    schedules: new Set(
      vehicles.flatMap((vehicle) =>
        ((vehicle.maintenanceSchedules as JsonRecord[] | undefined) ?? []).map((s) => String(s.id)),
      ),
    ),
    records: new Set(maintenanceRecords.map((record) => String(record.id))),
    expenses: new Set(expenses.map((expense) => String(expense.id))),
    fuelEntries: new Set(fuelEntries.map((entry) => String(entry.id))),
    noteTags: new Set(noteTags.map((tag) => String(tag.id))),
  };
  for (const record of maintenanceRecords) {
    assertOwnRef(record.vehicleId, own.vehicles);
    assertOwnRef(record.scheduleId, own.schedules, { nullable: true });
  }
  for (const expense of expenses) {
    assertOwnRef(expense.vehicleId, own.vehicles);
    assertOwnRef(expense.maintenanceRecordId, own.records, { nullable: true });
  }
  for (const entry of fuelEntries) assertOwnRef(entry.vehicleId, own.vehicles);
  for (const log of odometerLogs) assertOwnRef(log.vehicleId, own.vehicles);
  for (const field of customFields) {
    for (const value of (field.values as JsonRecord[] | undefined) ?? []) {
      assertOwnRef(value.vehicleId, own.vehicles);
    }
  }
  for (const note of notes) {
    assertOwnRef(note.vehicleId, own.vehicles, { nullable: true });
    assertOwnRef(note.maintenanceRecordId, own.records, { nullable: true });
    for (const tagId of Array.isArray(note.tagIds) ? note.tagIds : []) {
      assertOwnRef(tagId, own.noteTags);
    }
  }
  for (const item of wishlistItems) assertOwnRef(item.vehicleId, own.vehicles, { nullable: true });
  const plannedDocuments = documents.map((document) => planDocument(userId, document, own));

  const oldDocuments = await prisma.document.findMany({
    where: {
      OR: [{ uploadedByUserId: userId }, { vehicle: { ownerUserId: userId } }],
    },
    select: { storageKey: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.document.deleteMany({
      where: {
        OR: [{ uploadedByUserId: userId }, { vehicle: { ownerUserId: userId } }],
      },
    });
    await tx.note.deleteMany({ where: { ownerUserId: userId } });
    await tx.noteTag.deleteMany({ where: { ownerUserId: userId } });
    await tx.wishlistItem.deleteMany({ where: { userId } });
    await tx.expense.deleteMany({ where: { createdByUserId: userId } });
    await tx.fuelEntry.deleteMany({ where: { createdByUserId: userId } });
    await tx.maintenanceRecord.deleteMany({ where: { createdByUserId: userId } });
    await tx.vehicleCustomField.deleteMany({ where: { userId } });
    // Cascades to OdometerLog and VehicleCustomFieldValue.
    await tx.vehicle.deleteMany({ where: { ownerUserId: userId } });

    const preferences = data.preferences as JsonRecord | null | undefined;
    if (preferences) {
      const backgroundImageKey = ownBackgroundKey(userId, preferences.backgroundImageKey);
      await tx.userPreferences.upsert({
        where: { userId },
        create: {
          userId,
          theme: String(preferences.theme ?? "system"),
          locale: String(preferences.locale ?? "de"),
          timezone: String(preferences.timezone ?? "Europe/Berlin"),
          currency: String(preferences.currency ?? "EUR"),
          distanceUnit: String(preferences.distanceUnit ?? "km"),
          volumeUnit: String(preferences.volumeUnit ?? "l"),
          hiddenVehicleFields: String(preferences.hiddenVehicleFields ?? ""),
          designPreset: String(preferences.designPreset ?? "default"),
          backgroundBlurPx: intOrNull(preferences.backgroundBlurPx) ?? 8,
          backgroundImageKey: backgroundImageKey,
          backgroundMimeType: backgroundImageKey ? textOrNull(preferences.backgroundMimeType) : null,
          quickFuelEnabled: Boolean(preferences.quickFuelEnabled ?? true),
          maintenanceDueSoonKm: intOrNull(preferences.maintenanceDueSoonKm) ?? 1500,
          maintenanceDueSoonDays:
            intOrNull(preferences.maintenanceDueSoonDays) ?? 30,
        },
        update: {
          theme: String(preferences.theme ?? "system"),
          locale: String(preferences.locale ?? "de"),
          timezone: String(preferences.timezone ?? "Europe/Berlin"),
          currency: String(preferences.currency ?? "EUR"),
          distanceUnit: String(preferences.distanceUnit ?? "km"),
          volumeUnit: String(preferences.volumeUnit ?? "l"),
          hiddenVehicleFields: String(preferences.hiddenVehicleFields ?? ""),
          designPreset: String(preferences.designPreset ?? "default"),
          backgroundBlurPx: intOrNull(preferences.backgroundBlurPx) ?? 8,
          backgroundImageKey: backgroundImageKey,
          backgroundMimeType: backgroundImageKey ? textOrNull(preferences.backgroundMimeType) : null,
          quickFuelEnabled: Boolean(preferences.quickFuelEnabled ?? true),
          maintenanceDueSoonKm: intOrNull(preferences.maintenanceDueSoonKm) ?? 1500,
          maintenanceDueSoonDays:
            intOrNull(preferences.maintenanceDueSoonDays) ?? 30,
        },
      });
    }

    const notifications = data.notificationSettings as JsonRecord | null | undefined;
    if (notifications) {
      await tx.userNotificationSettings.upsert({
        where: { userId },
        create: {
          userId,
          pushoverEnabled: Boolean(notifications.pushoverEnabled),
          pushoverUserKey: textOrNull(notifications.pushoverUserKey),
          pushoverAppToken: textOrNull(notifications.pushoverAppToken),
          telegramEnabled: Boolean(notifications.telegramEnabled),
          telegramBotToken: textOrNull(notifications.telegramBotToken),
          telegramChatId: textOrNull(notifications.telegramChatId),
          eventMaintenanceOverdue: Boolean(
            notifications.eventMaintenanceOverdue ?? true,
          ),
          eventMaintenanceDueSoon: Boolean(
            notifications.eventMaintenanceDueSoon ?? true,
          ),
          eventMaintenanceLogged: false,
          eventExpenseAdded: false,
          eventOdometerReminder: Boolean(notifications.eventOdometerReminder),
          odometerReminderDays: intOrNull(notifications.odometerReminderDays) ?? 7,
          deliveryImmediate: Boolean(notifications.deliveryImmediate ?? true),
          deliveryScheduled: Boolean(notifications.deliveryScheduled),
          scheduledTime: textOrNull(notifications.scheduledTime) ?? "08:00",
          scheduledDays:
            textOrNull(notifications.scheduledDays) ?? "MO,TU,WE,TH,FR,SA,SU",
          minIntervalHours: intOrNull(notifications.minIntervalHours) ?? 6,
          quietHoursEnabled: Boolean(notifications.quietHoursEnabled),
          quietHoursStart: textOrNull(notifications.quietHoursStart) ?? "22:00",
          quietHoursEnd: textOrNull(notifications.quietHoursEnd) ?? "07:00",
          timezone: textOrNull(notifications.timezone) ?? "Europe/Berlin",
          lastMaintenanceAlertAt: dateOrNull(notifications.lastMaintenanceAlertAt),
          lastOdometerReminderAt: dateOrNull(notifications.lastOdometerReminderAt),
        },
        update: {
          pushoverEnabled: Boolean(notifications.pushoverEnabled),
          pushoverUserKey: textOrNull(notifications.pushoverUserKey),
          pushoverAppToken: textOrNull(notifications.pushoverAppToken),
          telegramEnabled: Boolean(notifications.telegramEnabled),
          telegramBotToken: textOrNull(notifications.telegramBotToken),
          telegramChatId: textOrNull(notifications.telegramChatId),
          eventMaintenanceOverdue: Boolean(
            notifications.eventMaintenanceOverdue ?? true,
          ),
          eventMaintenanceDueSoon: Boolean(
            notifications.eventMaintenanceDueSoon ?? true,
          ),
          eventMaintenanceLogged: false,
          eventExpenseAdded: false,
          eventOdometerReminder: Boolean(notifications.eventOdometerReminder),
          odometerReminderDays: intOrNull(notifications.odometerReminderDays) ?? 7,
          deliveryImmediate: Boolean(notifications.deliveryImmediate ?? true),
          deliveryScheduled: Boolean(notifications.deliveryScheduled),
          scheduledTime: textOrNull(notifications.scheduledTime) ?? "08:00",
          scheduledDays:
            textOrNull(notifications.scheduledDays) ?? "MO,TU,WE,TH,FR,SA,SU",
          minIntervalHours: intOrNull(notifications.minIntervalHours) ?? 6,
          quietHoursEnabled: Boolean(notifications.quietHoursEnabled),
          quietHoursStart: textOrNull(notifications.quietHoursStart) ?? "22:00",
          quietHoursEnd: textOrNull(notifications.quietHoursEnd) ?? "07:00",
          timezone: textOrNull(notifications.timezone) ?? "Europe/Berlin",
          lastMaintenanceAlertAt: dateOrNull(notifications.lastMaintenanceAlertAt),
          lastOdometerReminderAt: dateOrNull(notifications.lastOdometerReminderAt),
        },
      });
    }

    for (const vehicle of vehicles) {
      await tx.vehicle.create({
        data: {
          id: String(vehicle.id),
          ownerUserId: userId,
          catalogModelYearId: textOrNull(vehicle.catalogModelYearId),
          manufacturerId: textOrNull(vehicle.manufacturerId),
          make: textOrNull(vehicle.make),
          model: textOrNull(vehicle.model),
          productionYear: intOrNull(vehicle.productionYear),
          year: intOrNull(vehicle.year),
          vin: textOrNull(vehicle.vin),
          hsn: textOrNull(vehicle.hsn),
          tsn: textOrNull(vehicle.tsn),
          licensePlate: textOrNull(vehicle.licensePlate),
          color: textOrNull(vehicle.color),
          currentOdometerKm: intOrNull(vehicle.currentOdometerKm) ?? 0,
          purchaseDate: dateOrNull(vehicle.purchaseDate),
          purchasePriceCents: bigintOrNull(vehicle.purchasePriceCents),
          purchaseCurrency: textOrNull(vehicle.purchaseCurrency) ?? "EUR",
          notes: textOrNull(vehicle.notes),
          metadata: jsonOrUndefined(vehicle.metadata),
          createdAt: dateOrNull(vehicle.createdAt) ?? new Date(),
          updatedAt: dateOrNull(vehicle.updatedAt) ?? new Date(),
        },
      });

      const factorySpecs = vehicle.factorySpecs as JsonRecord | null | undefined;
      if (factorySpecs) {
        await tx.vehicleFactorySpec.create({
          data: {
            vehicleId: String(vehicle.id),
            engineCode: textOrNull(factorySpecs.engineCode),
            engineDescription: textOrNull(factorySpecs.engineDescription),
            powerKw: intOrNull(factorySpecs.powerKw),
            powerPs: intOrNull(factorySpecs.powerPs),
            torqueNm: intOrNull(factorySpecs.torqueNm),
            fuelType: textOrNull(factorySpecs.fuelType) as never,
            displacementCc: intOrNull(factorySpecs.displacementCc),
            cylinders: intOrNull(factorySpecs.cylinders),
            doors: intOrNull(factorySpecs.doors),
            seats: intOrNull(factorySpecs.seats),
            bodyType: textOrNull(factorySpecs.bodyType) as never,
            driveType: textOrNull(factorySpecs.driveType) as never,
            transmissionTypes: jsonOrUndefined(factorySpecs.transmissionTypes),
            productionYearFrom: intOrNull(factorySpecs.productionYearFrom),
            productionYearTo: intOrNull(factorySpecs.productionYearTo),
            rawCatalog: jsonOrUndefined(factorySpecs.rawCatalog),
            createdAt: dateOrNull(factorySpecs.createdAt) ?? new Date(),
          },
        });
      }

      const currentSpecs = vehicle.currentSpecs as JsonRecord | null | undefined;
      if (currentSpecs) {
        await tx.vehicleCurrentSpec.create({
          data: {
            vehicleId: String(vehicle.id),
            engineCode: textOrNull(currentSpecs.engineCode),
            engineDescription: textOrNull(currentSpecs.engineDescription),
            powerKw: intOrNull(currentSpecs.powerKw),
            powerPs: intOrNull(currentSpecs.powerPs),
            torqueNm: intOrNull(currentSpecs.torqueNm),
            fuelType: textOrNull(currentSpecs.fuelType) as never,
            displacementCc: intOrNull(currentSpecs.displacementCc),
            cylinders: intOrNull(currentSpecs.cylinders),
            doors: intOrNull(currentSpecs.doors),
            seats: intOrNull(currentSpecs.seats),
            bodyType: textOrNull(currentSpecs.bodyType) as never,
            driveType: textOrNull(currentSpecs.driveType) as never,
            transmissionTypes: jsonOrUndefined(currentSpecs.transmissionTypes),
            updatedAt: dateOrNull(currentSpecs.updatedAt) ?? new Date(),
          },
        });
      }

      for (const modification of (vehicle.modifications as JsonRecord[] | undefined) ?? []) {
        await tx.vehicleModification.create({
          data: {
            id: String(modification.id),
            vehicleId: String(vehicle.id),
            category: String(modification.category) as never,
            name: String(modification.name ?? "Modification"),
            description: textOrNull(modification.description),
            installedAt: dateOrNull(modification.installedAt),
            costCents: bigintOrNull(modification.costCents),
            currency: textOrNull(modification.currency) ?? "EUR",
            addedPowerKw: intOrNull(modification.addedPowerKw),
            addedPowerPs: intOrNull(modification.addedPowerPs),
            addedTorqueNm: intOrNull(modification.addedTorqueNm),
            notes: textOrNull(modification.notes),
            isCustom: Boolean(modification.isCustom),
            createdAt: dateOrNull(modification.createdAt) ?? new Date(),
            updatedAt: dateOrNull(modification.updatedAt) ?? new Date(),
          },
        });
      }

      for (const schedule of (vehicle.maintenanceSchedules as JsonRecord[] | undefined) ?? []) {
        await tx.vehicleMaintenanceSchedule.create({
          data: {
            id: String(schedule.id),
            vehicleId: String(vehicle.id),
            templateId: textOrNull(schedule.templateId),
            customName: textOrNull(schedule.customName),
            category: String(schedule.category ?? "OTHER") as never,
            intervalKm: intOrNull(schedule.intervalKm),
            intervalMonths: intOrNull(schedule.intervalMonths),
            lastPerformedAt: dateOrNull(schedule.lastPerformedAt),
            lastOdometerKm: intOrNull(schedule.lastOdometerKm),
            nextDueAt: dateOrNull(schedule.nextDueAt),
            nextDueOdometerKm: intOrNull(schedule.nextDueOdometerKm),
            estimatedCostCents: bigintOrNull(schedule.estimatedCostCents),
            currency: textOrNull(schedule.currency) ?? "EUR",
            notes: textOrNull(schedule.notes),
            isActive: Boolean(schedule.isActive ?? true),
            dueStatus: String(schedule.dueStatus ?? "OK") as never,
            createdAt: dateOrNull(schedule.createdAt) ?? new Date(),
            updatedAt: dateOrNull(schedule.updatedAt) ?? new Date(),
          },
        });

        for (const item of (schedule.itemDefaults as JsonRecord[] | undefined) ?? []) {
          await tx.maintenanceItemDefault.create({
            data: {
              id: String(item.id),
              scheduleId: String(schedule.id),
              category: String(item.category ?? "OTHER") as never,
              name: textOrNull(item.name),
              brand: textOrNull(item.brand),
              productName: textOrNull(item.productName),
              partNumber: textOrNull(item.partNumber),
              specification: textOrNull(item.specification),
              quantity: item.quantity == null ? null : Number(item.quantity),
              unit: textOrNull(item.unit) as never,
              customUnit: textOrNull(item.customUnit),
              costCents: bigintOrNull(item.costCents),
              currency: textOrNull(item.currency) ?? "EUR",
              supplierName: textOrNull(item.supplierName),
              notes: textOrNull(item.notes),
              sortOrder: intOrNull(item.sortOrder) ?? 0,
              createdAt: dateOrNull(item.createdAt) ?? new Date(),
              updatedAt: dateOrNull(item.updatedAt) ?? new Date(),
            },
          });
        }
      }

      for (const inspection of (vehicle.inspections as JsonRecord[] | undefined) ?? []) {
        await tx.vehicleInspection.create({
          data: {
            id: String(inspection.id),
            vehicleId: String(vehicle.id),
            type: String(inspection.type) as never,
            nextDueAt: dateOrNull(inspection.nextDueAt) ?? new Date(),
            lastPerformedAt: dateOrNull(inspection.lastPerformedAt),
            reminderWeeksBefore: intOrNull(inspection.reminderWeeksBefore) ?? 4,
            stickerNumber: textOrNull(inspection.stickerNumber),
            notes: textOrNull(inspection.notes),
            createdAt: dateOrNull(inspection.createdAt) ?? new Date(),
            updatedAt: dateOrNull(inspection.updatedAt) ?? new Date(),
          },
        });
      }

      for (const policy of (vehicle.insurancePolicies as JsonRecord[] | undefined) ?? []) {
        await tx.insurancePolicy.create({
          data: {
            id: String(policy.id),
            vehicleId: String(vehicle.id),
            provider: String(policy.provider ?? ""),
            policyNumber: textOrNull(policy.policyNumber),
            premiumCents: bigintOrZero(policy.premiumCents),
            currency: textOrNull(policy.currency) ?? "EUR",
            sfClass: textOrNull(policy.sfClass),
            coverageType: String(policy.coverageType ?? "LIABILITY") as never,
            startDate: dateOrNull(policy.startDate) ?? new Date(),
            endDate: dateOrNull(policy.endDate) ?? new Date(),
            autoRenew: Boolean(policy.autoRenew ?? true),
            notes: textOrNull(policy.notes),
            createdAt: dateOrNull(policy.createdAt) ?? new Date(),
            updatedAt: dateOrNull(policy.updatedAt) ?? new Date(),
          },
        });
      }
    }

    for (const record of maintenanceRecords) {
      await tx.maintenanceRecord.create({
        data: {
          id: String(record.id),
          vehicleId: String(record.vehicleId),
          scheduleId: textOrNull(record.scheduleId),
          performedAt: dateOrNull(record.performedAt) ?? new Date(),
          odometerKm: intOrNull(record.odometerKm),
          costCents: bigintOrZero(record.costCents),
          currency: textOrNull(record.currency) ?? "EUR",
          vendorName: textOrNull(record.vendorName),
          title: textOrNull(record.title),
          note: textOrNull(record.note),
          createdByUserId: userId,
          createdAt: dateOrNull(record.createdAt) ?? new Date(),
          updatedAt: dateOrNull(record.updatedAt) ?? new Date(),
        },
      });

      for (const item of (record.items as JsonRecord[] | undefined) ?? []) {
        await tx.maintenanceItem.create({
          data: {
            id: String(item.id),
            recordId: String(record.id),
            category: String(item.category ?? "OTHER") as never,
            name: textOrNull(item.name),
            brand: textOrNull(item.brand),
            productName: textOrNull(item.productName),
            partNumber: textOrNull(item.partNumber),
            specification: textOrNull(item.specification),
            quantity: item.quantity == null ? null : Number(item.quantity),
            unit: textOrNull(item.unit) as never,
            customUnit: textOrNull(item.customUnit),
            costCents: bigintOrNull(item.costCents),
            currency: textOrNull(item.currency) ?? "EUR",
            supplierName: textOrNull(item.supplierName),
            notes: textOrNull(item.notes),
            sortOrder: intOrNull(item.sortOrder) ?? 0,
            createdAt: dateOrNull(item.createdAt) ?? new Date(),
            updatedAt: dateOrNull(item.updatedAt) ?? new Date(),
          },
        });
      }
    }

    for (const expense of expenses) {
      await tx.expense.create({
        data: {
          id: String(expense.id),
          vehicleId: String(expense.vehicleId),
          category: String(expense.category ?? "OTHER") as never,
          occurredAt: dateOrNull(expense.occurredAt) ?? new Date(),
          amountCents: bigintOrZero(expense.amountCents),
          currency: textOrNull(expense.currency) ?? "EUR",
          odometerKm: intOrNull(expense.odometerKm),
          maintenanceRecordId: textOrNull(expense.maintenanceRecordId),
          description: textOrNull(expense.description),
          createdByUserId: userId,
          createdAt: dateOrNull(expense.createdAt) ?? new Date(),
          updatedAt: dateOrNull(expense.updatedAt) ?? new Date(),
        },
      });
    }

    for (const entry of fuelEntries) {
      await tx.fuelEntry.create({
        data: {
          id: String(entry.id),
          vehicleId: String(entry.vehicleId),
          filledAt: dateOrNull(entry.filledAt) ?? new Date(),
          odometerKm: intOrNull(entry.odometerKm),
          liters: entry.liters == null ? null : Number(entry.liters),
          totalCostCents: bigintOrZero(entry.totalCostCents),
          currency: textOrNull(entry.currency) ?? "EUR",
          stationName: textOrNull(entry.stationName),
          note: textOrNull(entry.note),
          createdByUserId: userId,
          createdAt: dateOrNull(entry.createdAt) ?? new Date(),
          updatedAt: dateOrNull(entry.updatedAt) ?? new Date(),
        },
      });
    }

    for (const planned of plannedDocuments) {
      const document = planned.source;
      await tx.document.create({
        data: {
          id: String(document.id),
          uploadedByUserId: userId,
          vehicleId: planned.vehicleId,
          maintenanceRecordId: textOrNull(document.maintenanceRecordId),
          expenseId: textOrNull(document.expenseId),
          fuelEntryId: textOrNull(document.fuelEntryId),
          purpose: planned.purpose,
          category: planned.category,
          title: textOrNull(document.title),
          originalFilename: planned.originalFilename,
          storageKey: planned.storageKey,
          storageBackend: "local",
          mimeType: planned.mimeType,
          sizeBytes: planned.sizeBytes,
          width: intOrNull(document.width),
          height: intOrNull(document.height),
          sha256: textOrNull(document.sha256),
          deletedAt: dateOrNull(document.deletedAt),
          createdAt: dateOrNull(document.createdAt) ?? new Date(),
          updatedAt: dateOrNull(document.updatedAt) ?? new Date(),
        },
      });
    }

    for (const tag of noteTags) {
      await tx.noteTag.create({
        data: {
          id: String(tag.id),
          ownerUserId: userId,
          name: String(tag.name ?? "Tag"),
          createdAt: dateOrNull(tag.createdAt) ?? new Date(),
        },
      });
    }

    for (const note of notes) {
      const tagIds = Array.isArray(note.tagIds)
        ? note.tagIds.map((id) => String(id))
        : [];
      await tx.note.create({
        data: {
          id: String(note.id),
          ownerUserId: userId,
          title: String(note.title ?? "Note"),
          content: String(note.content ?? ""),
          vehicleId: textOrNull(note.vehicleId),
          maintenanceTemplateId: textOrNull(note.maintenanceTemplateId),
          maintenanceRecordId: textOrNull(note.maintenanceRecordId),
          isPinned: Boolean(note.isPinned),
          createdAt: dateOrNull(note.createdAt) ?? new Date(),
          updatedAt: dateOrNull(note.updatedAt) ?? new Date(),
          tags: { connect: tagIds.map((id) => ({ id })) },
        },
      });
    }

    for (const log of odometerLogs) {
      await tx.odometerLog.create({
        data: {
          id: String(log.id),
          vehicleId: String(log.vehicleId),
          odometerKm: intOrNull(log.odometerKm) ?? 0,
          recordedAt: dateOrNull(log.recordedAt) ?? new Date(),
          source: textOrNull(log.source) ?? "manual",
          note: textOrNull(log.note),
          createdByUserId: userId,
          createdAt: dateOrNull(log.createdAt) ?? new Date(),
          updatedAt: dateOrNull(log.updatedAt) ?? new Date(),
        },
      });
    }

    for (const field of customFields) {
      await tx.vehicleCustomField.create({
        data: {
          id: String(field.id),
          userId,
          label: String(field.label ?? "Field"),
          fieldType: textOrNull(field.fieldType) ?? "TEXT",
          unit: textOrNull(field.unit),
          position: intOrNull(field.position) ?? 0,
          createdAt: dateOrNull(field.createdAt) ?? new Date(),
          updatedAt: dateOrNull(field.updatedAt) ?? new Date(),
        },
      });

      for (const value of (field.values as JsonRecord[] | undefined) ?? []) {
        await tx.vehicleCustomFieldValue.create({
          data: {
            id: String(value.id),
            fieldId: String(field.id),
            vehicleId: String(value.vehicleId),
            value: String(value.value ?? ""),
            createdAt: dateOrNull(value.createdAt) ?? new Date(),
            updatedAt: dateOrNull(value.updatedAt) ?? new Date(),
          },
        });
      }
    }

    for (const item of wishlistItems) {
      await tx.wishlistItem.create({
        data: {
          id: String(item.id),
          userId,
          vehicleId: textOrNull(item.vehicleId),
          title: String(item.title ?? "Wishlist item"),
          description: textOrNull(item.description),
          category: String(item.category ?? "OTHER") as never,
          status: String(item.status ?? "IDEA") as never,
          priority: intOrNull(item.priority) ?? 0,
          targetDate: dateOrNull(item.targetDate),
          url: textOrNull(item.url),
          estimatedCostCents: bigintOrNull(item.estimatedCostCents),
          currency: textOrNull(item.currency) ?? "EUR",
          plannedMake: textOrNull(item.plannedMake),
          plannedModel: textOrNull(item.plannedModel),
          plannedYear: intOrNull(item.plannedYear),
          plannedBudgetCents: bigintOrNull(item.plannedBudgetCents),
          createdAt: dateOrNull(item.createdAt) ?? new Date(),
          updatedAt: dateOrNull(item.updatedAt) ?? new Date(),
        },
      });
    }

    // Restored rows keep their original timestamps, which an incremental sync
    // would never pick up. Tell this user's API clients (and those of anyone
    // the vehicles are shared with) to resync from scratch.
    await tx.syncTombstone.create({
      data: { entity: "*", entityId: userId, userId },
    });
  });

  await Promise.all(oldDocuments.map((doc) => deleteStoredFile(doc.storageKey)));
  await Promise.all(
    plannedDocuments.map(async (planned) => {
      if (!planned.file) return;
      await restoreStoredFile(planned.storageKey, planned.file);
    }),
  );

  return {
    vehicles: vehicles.length,
    maintenanceRecords: maintenanceRecords.length,
    expenses: expenses.length,
    fuelEntries: fuelEntries.length,
    documents: documents.length,
    notes: notes.length,
    wishlistItems: wishlistItems.length,
    odometerLogs: odometerLogs.length,
    customFields: customFields.length,
  };
}

export function expensesToCsv(
  expenses: Array<{
    occurredAt: Date;
    category: string;
    amountCents: bigint;
    currency: string;
    description: string | null;
    vehicleId: string;
  }>,
  vehicleNames: Map<string, string>,
): string {
  const header = "date,category,amount,currency,vehicle,description";
  const rows = expenses.map((e) => {
    const amount = (Number(e.amountCents) / 100).toFixed(2);
    const vehicle = vehicleNames.get(e.vehicleId) ?? e.vehicleId;
    const desc = (e.description ?? "").replace(/"/g, '""');
    return `${e.occurredAt.toISOString().slice(0, 10)},${e.category},${amount},${e.currency},"${vehicle}","${desc}"`;
  });
  return [header, ...rows].join("\n");
}
