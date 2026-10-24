import { getCurrentUserId } from "@/lib/auth/current-user";
import {
  computeOdometerAnalytics,
  type OdometerAnalytics,
} from "@/lib/fuel/odometer-analytics";
import {
  createOdometerLogEntry,
  deleteOdometerLogEntry,
  listOdometerLogsForOwner,
  type SerializedOdometerLog,
} from "@/lib/repositories/odometer";
import { listAccessibleVehicles } from "@/lib/repositories/vehicles";
import { resolveVehicleAccess } from "@/lib/vehicles/access";
import { prisma } from "@/lib/prisma";
import { updateOdometerForUser } from "@/lib/services/vehicles";
import { serialisedPerVehicle } from "@/lib/vehicles/odometer-queue";

export type OdometerPageData = {
  logs: SerializedOdometerLog[];
  analytics: OdometerAnalytics;
  vehicles: { id: string; label: string }[];
};

export async function getOdometerPageData(
  vehicleId?: string,
): Promise<OdometerPageData> {
  const userId = await getCurrentUserId();
  const [logs, vehicles] = await Promise.all([
    listOdometerLogsForOwner(userId, vehicleId),
    listAccessibleVehicles(userId),
  ]);

  return {
    logs,
    analytics: computeOdometerAnalytics(logs),
    vehicles: vehicles.map((vehicle) => ({
      id: vehicle.id,
      label:
        [vehicle.make, vehicle.model].filter(Boolean).join(" ") ||
        vehicle.licensePlate ||
        vehicle.id,
    })),
  };
}

/**
 * Records a reading and, when it is the newest one, moves the vehicle's current
 * odometer forward. Back-dated or lower readings are still stored (they belong
 * in the history) but must never pull the current reading down — the same rule
 * the maintenance history follows.
 */
/** Returns the new reading's id. */
export async function logOdometerReading(input: {
  vehicleId: string;
  odometerKm: number;
  recordedAt?: Date;
  note?: string | null;
}): Promise<string> {
  const userId = await getCurrentUserId();
  const access = await resolveVehicleAccess(userId, input.vehicleId);
  if (!access?.canEdit) throw new Error("VEHICLE_NOT_FOUND");

  if (!Number.isFinite(input.odometerKm) || input.odometerKm < 0) {
    throw new Error("ODOMETER_INVALID");
  }

  const odometerKm = Math.round(input.odometerKm);

  const log = await createOdometerLogEntry({
    vehicleId: input.vehicleId,
    userId,
    odometerKm,
    recordedAt: input.recordedAt,
    note: input.note ?? null,
  });

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: input.vehicleId },
    select: { currentOdometerKm: true },
  });

  if (vehicle && odometerKm > vehicle.currentOdometerKm) {
    await prisma.vehicle.update({
      where: { id: input.vehicleId },
      data: { currentOdometerKm: odometerKm },
    });
  }

  return log.id;
}

/** `OdometerLog.source` for readings the app read from an OBD adapter (D-046). */
export const OBD_SOURCE = "obd";

/**
 * Records a reading the app read from an OBD adapter. Unlike a manual
 * reading it must be strictly higher than both the vehicle's current
 * odometer and its newest log (else `ODOMETER_NOT_HIGHER`), and it is written
 * through the web UI's quick-update path, like the WiCAN ingest (D-045).
 * Check and write run serialised per vehicle so overlapping uploads can't
 * both pass. Returns the new reading's id.
 */
export async function logObdOdometerReading(input: {
  vehicleId: string;
  userId: string;
  odometerKm: number;
  recordedAt?: Date;
  note?: string | null;
}): Promise<string> {
  const access = await resolveVehicleAccess(input.userId, input.vehicleId);
  if (!access?.canEdit) throw new Error("VEHICLE_NOT_FOUND");
  if (!Number.isInteger(input.odometerKm) || input.odometerKm < 0) {
    throw new Error("ODOMETER_INVALID");
  }

  return serialisedPerVehicle(input.vehicleId, async () => {
    const [vehicle, newest] = await Promise.all([
      prisma.vehicle.findFirst({
        where: { id: input.vehicleId, deletedAt: null },
        select: { currentOdometerKm: true },
      }),
      prisma.odometerLog.findFirst({
        where: { vehicleId: input.vehicleId },
        orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
        select: { odometerKm: true },
      }),
    ]);
    if (!vehicle) throw new Error("VEHICLE_NOT_FOUND");
    if (input.odometerKm <= Math.max(vehicle.currentOdometerKm, newest?.odometerKm ?? 0)) {
      throw new Error("ODOMETER_NOT_HIGHER");
    }

    const result = await updateOdometerForUser(
      input.vehicleId,
      input.userId,
      input.odometerKm,
      OBD_SOURCE,
      input.recordedAt,
      input.note,
    );
    if (!result.success || !result.logId) {
      throw new Error(
        result.error?.code === "mileageInvalid" ? "ODOMETER_INVALID" : "VEHICLE_NOT_FOUND",
      );
    }
    return result.logId;
  });
}

export async function deleteOdometerReading(logId: string) {
  const userId = await getCurrentUserId();
  const deleted = await deleteOdometerLogEntry(logId, userId);
  if (!deleted) throw new Error("ODOMETER_LOG_NOT_FOUND");
}
