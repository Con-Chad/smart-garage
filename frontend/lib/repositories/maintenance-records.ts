import type { MaintenanceCategory, Prisma } from "@prisma/client";
import type { Locale } from "@/lib/i18n/routing";
import { scheduleDisplayName } from "@/lib/maintenance/display";
import { prisma } from "@/lib/prisma";
import { vehicleAccessWhere, vehicleEditWhere } from "@/lib/vehicles/access";
import {
  listItemsForRecords,
  type SerializedMaintenanceItem,
} from "@/lib/repositories/maintenance-items";

export type SerializedMaintenanceRecord = {
  id: string;
  scheduleId: string | null;
  templateSlug: string | null;
  vehicleId: string;
  vehicleName: string;
  serviceName: string;
  performedAt: string;
  odometerKm: number | null;
  costCents: number;
  currency: string;
  vendorName: string | null;
  note: string | null;
  items: SerializedMaintenanceItem[];
};

const recordInclude = {
  vehicle: {
    select: {
      id: true,
      make: true,
      model: true,
      licensePlate: true,
      ownerUserId: true,
    },
  },
  schedule: {
    include: { template: true },
  },
} as const;

type RecordRow = Awaited<
  ReturnType<
    typeof prisma.maintenanceRecord.findMany<{ include: typeof recordInclude }>
  >
>[number];

function vehicleLabel(
  vehicle: RecordRow["vehicle"],
): string {
  const name = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
  return name || vehicle.licensePlate || "Vehicle";
}

function serviceName(record: RecordRow, locale: Locale): string {
  if (record.schedule) return scheduleDisplayName(record.schedule, locale);
  if (record.title?.trim()) return record.title.trim();
  return locale === "de" ? "Wartung" : "Maintenance";
}

export function serializeMaintenanceRecord(
  record: RecordRow,
  locale: Locale,
  items: SerializedMaintenanceItem[] = [],
): SerializedMaintenanceRecord {
  return {
    id: record.id,
    scheduleId: record.scheduleId,
    templateSlug: record.schedule?.template?.slug ?? null,
    vehicleId: record.vehicleId,
    vehicleName: vehicleLabel(record.vehicle),
    serviceName: serviceName(record, locale),
    performedAt: record.performedAt.toISOString(),
    odometerKm: record.odometerKm,
    costCents: Number(record.costCents),
    currency: record.currency,
    vendorName: record.vendorName,
    note: record.note,
    items,
  };
}

export async function listRecordsForSchedule(
  scheduleId: string,
  userId: string,
  locale: Locale,
) {
  const records = await prisma.maintenanceRecord.findMany({
    where: {
      scheduleId,
      vehicle: vehicleAccessWhere(userId),
    },
    include: recordInclude,
    orderBy: [{ performedAt: "desc" }, { odometerKm: "desc" }, { createdAt: "desc" }],
  });

  const itemsByRecord = await listItemsForRecords(records.map((r) => r.id));
  return records.map((record) =>
    serializeMaintenanceRecord(record, locale, itemsByRecord.get(record.id) ?? []),
  );
}

/** A record the user may change (owner or shared editor), or null. */
export async function findRecordForOwner(recordId: string, userId: string) {
  return prisma.maintenanceRecord.findFirst({
    where: {
      id: recordId,
      vehicle: vehicleEditWhere(userId),
    },
    include: {
      vehicle: { select: { id: true, currentOdometerKm: true, ownerUserId: true } },
      schedule: true,
    },
  });
}

export async function countRecordsForSchedule(
  scheduleId: string,
  userId: string,
) {
  return prisma.maintenanceRecord.count({
    where: {
      scheduleId,
      vehicle: vehicleAccessWhere(userId),
    },
  });
}

/**
 * Hard-deletes a maintenance record the user may edit. Linked maintenance items
 * cascade automatically; any auto-created expense linked to this record is
 * removed in the same transaction so an accidental log leaves nothing behind.
 * Notes/documents keep their history (their FK is set to null by the schema).
 * Returns the deleted record's `scheduleId` (or null) and the vehicle owner,
 * so callers can refresh the schedule's due status with the owner's thresholds.
 */
export async function deleteMaintenanceRecord(
  recordId: string,
  userId: string,
): Promise<{ scheduleId: string | null; vehicleOwnerId: string } | null> {
  const record = await prisma.maintenanceRecord.findFirst({
    where: {
      id: recordId,
      vehicle: vehicleEditWhere(userId),
    },
    select: { id: true, scheduleId: true, vehicle: { select: { ownerUserId: true } } },
  });
  if (!record) return null;

  await prisma.$transaction(async (tx) => {
    await tx.expense.deleteMany({ where: { maintenanceRecordId: record.id } });
    await tx.maintenanceRecord.delete({ where: { id: record.id } });
  });

  return { scheduleId: record.scheduleId, vehicleOwnerId: record.vehicle.ownerUserId };
}

export type HistoryFilters = {
  search?: string;
  vehicleId?: string;
  category?: string;
  fromDate?: string;
  toDate?: string;
};

export async function listAllRecordsForOwner(
  userId: string,
  locale: Locale,
  limit = 200,
  filters: HistoryFilters = {},
) {
  const search = filters.search?.trim();

  const where: Prisma.MaintenanceRecordWhereInput = {
    vehicle: vehicleAccessWhere(userId),
  };

  if (filters.vehicleId) {
    where.vehicleId = filters.vehicleId;
  }
  if (filters.category) {
    where.schedule = { category: filters.category as MaintenanceCategory };
  }
  if (filters.fromDate || filters.toDate) {
    where.performedAt = {
      ...(filters.fromDate ? { gte: new Date(filters.fromDate) } : {}),
      ...(filters.toDate ? { lte: new Date(`${filters.toDate}T23:59:59`) } : {}),
    };
  }
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { note: { contains: search } },
      { vendorName: { contains: search } },
      {
        items: {
          some: {
            OR: [
              { name: { contains: search } },
              { brand: { contains: search } },
              { productName: { contains: search } },
              { partNumber: { contains: search } },
              { specification: { contains: search } },
            ],
          },
        },
      },
    ];
  }

  const records = await prisma.maintenanceRecord.findMany({
    where,
    include: recordInclude,
    orderBy: [{ performedAt: "desc" }, { odometerKm: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  const itemsByRecord = await listItemsForRecords(records.map((r) => r.id));
  return records.map((record) =>
    serializeMaintenanceRecord(record, locale, itemsByRecord.get(record.id) ?? []),
  );
}
