import { prisma } from "@/lib/prisma";
import { vehicleAccessWhere, vehicleEditWhere } from "@/lib/vehicles/access";

export type SerializedFuelEntry = {
  id: string;
  vehicleId: string;
  vehicleName: string | null;
  filledAt: string;
  odometerKm: number | null;
  liters: number | null;
  totalCostCents: number;
  currency: string;
  stationName: string | null;
  note: string | null;
};

const fuelInclude = {
  vehicle: {
    select: {
      id: true,
      make: true,
      model: true,
      licensePlate: true,
      ownerUserId: true,
    },
  },
} as const;

type FuelRow = Awaited<
  ReturnType<typeof prisma.fuelEntry.findMany<{ include: typeof fuelInclude }>>
>[number];

function vehicleLabel(vehicle: FuelRow["vehicle"]): string | null {
  const name = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
  return name || vehicle.licensePlate || null;
}

export function serializeFuelEntry(entry: FuelRow): SerializedFuelEntry {
  return {
    id: entry.id,
    vehicleId: entry.vehicleId,
    vehicleName: vehicleLabel(entry.vehicle),
    filledAt: entry.filledAt.toISOString(),
    odometerKm: entry.odometerKm,
    liters: entry.liters,
    totalCostCents: Number(entry.totalCostCents),
    currency: entry.currency,
    stationName: entry.stationName,
    note: entry.note,
  };
}

/** Fill-ups on vehicles the user owns or that are shared with them. */
export async function listFuelEntriesForOwner(
  userId: string,
  vehicleId?: string,
) {
  return prisma.fuelEntry.findMany({
    where: {
      vehicle: vehicleAccessWhere(userId),
      ...(vehicleId ? { vehicleId } : {}),
    },
    include: fuelInclude,
    orderBy: [{ filledAt: "desc" }],
  });
}

export async function createFuelEntryRecord(input: {
  vehicleId: string;
  filledAt: Date;
  odometerKm?: number | null;
  liters?: number | null;
  totalCostCents: bigint;
  currency: string;
  stationName?: string | null;
  note?: string | null;
  createdByUserId: string;
}) {
  return prisma.fuelEntry.create({
    data: {
      vehicleId: input.vehicleId,
      filledAt: input.filledAt,
      odometerKm: input.odometerKm ?? null,
      liters: input.liters ?? null,
      totalCostCents: input.totalCostCents,
      currency: input.currency,
      stationName: input.stationName?.trim() || null,
      note: input.note?.trim() || null,
      createdByUserId: input.createdByUserId,
    },
    include: fuelInclude,
  });
}

/** Deletes a fill-up, scoped to vehicles the user may edit. */
export async function deleteFuelEntryRecord(entryId: string, userId: string) {
  const entry = await prisma.fuelEntry.findFirst({
    where: {
      id: entryId,
      vehicle: vehicleEditWhere(userId),
    },
  });
  if (!entry) return false;
  await prisma.fuelEntry.delete({ where: { id: entryId } });
  return true;
}

export async function countFuelEntriesForVehicle(vehicleId: string) {
  return prisma.fuelEntry.count({ where: { vehicleId } });
}
