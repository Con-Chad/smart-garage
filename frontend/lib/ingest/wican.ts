import { prisma } from "@/lib/prisma";
import { preferredToKm } from "@/lib/regional/distance";
import { updateOdometerForUser } from "@/lib/services/vehicles";
import type { DistanceUnit } from "@/lib/settings/types";

/**
 * WiCAN OBD adapter ingest (fork: con-chad/smart-garage). Everything comes
 * from env; without WICAN_INGEST_TOKEN the endpoint rejects every request.
 *
 *   WICAN_INGEST_TOKEN=...   shared secret the adapter sends as `Authorization: Bearer …`
 *   WICAN_ODO_UNIT=km        km | mi — unit of autopid_data.ODOMETER
 */

/** `OdometerLog.source` for readings written by the adapter. */
export const WICAN_SOURCE = "wican";

/**
 * A trip has ended once the adapter has been quiet this long; its last value
 * is then saved. One reading per trip, not one per POST cycle.
 */
export const WICAN_QUIET_MS = 30 * 60 * 1000;

/**
 * Autopid names tried for PID 01 31 (distance since codes cleared), which
 * OBD-II always reports in km. WiCAN names come from the vehicle profile, so
 * a few common spellings are accepted.
 */
export const WICAN_COUNTER_KEYS = [
  "DIST_SINCE_CODES_CLEARED",
  "DISTANCE_SINCE_CODES_CLEARED",
  "DIST_SINCE_CLR",
  "DIST_SINCE_DTC_CLR",
] as const;

type Env = Record<string, string | undefined>;

export type WicanConfig = {
  token: string | null;
  odometerUnit: DistanceUnit;
};

export function wicanConfig(env: Env = process.env): WicanConfig {
  const unit = (env.WICAN_ODO_UNIT ?? "").trim().toLowerCase();
  return {
    token: env.WICAN_INGEST_TOKEN?.trim() || null,
    odometerUnit: unit === "mi" ? "mi" : "km",
  };
}

export type WicanReadings = {
  /** In the unit of WICAN_ODO_UNIT. */
  odometer: number | null;
  /** Distance since codes cleared, km. */
  counterKm: number | null;
};

function finiteNonNegative(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Picks the values we use out of a WiCAN POST. Only `autopid_data` is read;
 * the boot-time `config`/`status` keys (Wi-Fi credentials) are never touched.
 */
export function readWicanPayload(body: unknown): WicanReadings {
  const data =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).autopid_data
      : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { odometer: null, counterKm: null };
  }
  const pids = data as Record<string, unknown>;
  let counterKm: number | null = null;
  for (const key of WICAN_COUNTER_KEYS) {
    counterKm = finiteNonNegative(pids[key]);
    if (counterKm !== null) break;
  }
  return { odometer: finiteNonNegative(pids.ODOMETER), counterKm };
}

export type WicanOutcome = "pending" | "no_reading" | "no_anchor" | "vehicle_not_found";

type WicanState = {
  vehicleId: string;
  pendingOdometerKm: number | null;
  lastSeenAt: Date | null;
  anchorLogId: string | null;
  anchorOdometerKm: number | null;
  anchorCounterKm: number | null;
};

/**
 * Odometer from the distance-since-codes-cleared counter:
 * last manual reading + (counter now − counter when that reading was anchored).
 * A newer manual reading, or a counter that went backwards (codes cleared),
 * re-anchors. Returns the value and the anchor fields to store.
 */
async function odometerFromCounter(
  vehicle: { id: string; currentOdometerKm: number },
  state: WicanState | null,
  counterKm: number,
): Promise<{ km: number; anchor: Partial<WicanState> } | null> {
  const manual = await prisma.odometerLog.findFirst({
    where: { vehicleId: vehicle.id, source: { not: WICAN_SOURCE } },
    orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, odometerKm: true },
  });
  if (!manual) return null;

  const anchorAt = (anchorOdometerKm: number) => ({
    km: anchorOdometerKm,
    anchor: { anchorLogId: manual.id, anchorOdometerKm, anchorCounterKm: counterKm },
  });

  if (
    !state ||
    state.anchorLogId !== manual.id ||
    state.anchorOdometerKm === null ||
    state.anchorCounterKm === null
  ) {
    return anchorAt(manual.odometerKm);
  }
  if (counterKm < state.anchorCounterKm) {
    // Codes were cleared: continue from the best reading we have.
    return anchorAt(
      Math.max(vehicle.currentOdometerKm, state.pendingOdometerKm ?? 0, state.anchorOdometerKm),
    );
  }
  return { km: state.anchorOdometerKm + (counterKm - state.anchorCounterKm), anchor: {} };
}

/**
 * Saves a finished trip's last value through the quick-update path, dated
 * when the adapter last posted — if it is higher than both the vehicle's
 * current reading and its newest log. Clears the pending value either way.
 */
async function flushPending(state: WicanState): Promise<void> {
  const { vehicleId, pendingOdometerKm, lastSeenAt } = state;
  if (pendingOdometerKm === null) return;
  await prisma.wicanVehicleState.update({
    where: { vehicleId },
    data: { pendingOdometerKm: null },
  });

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, deletedAt: null },
    select: { ownerUserId: true, currentOdometerKm: true },
  });
  if (!vehicle) return;
  const last = await prisma.odometerLog.findFirst({
    where: { vehicleId },
    orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
    select: { odometerKm: true },
  });
  if (pendingOdometerKm <= Math.max(vehicle.currentOdometerKm, last?.odometerKm ?? 0)) return;

  await updateOdometerForUser(
    vehicleId,
    vehicle.ownerUserId,
    pendingOdometerKm,
    WICAN_SOURCE,
    lastSeenAt ?? undefined,
  );
}

const isQuiet = (state: WicanState, now: Date) =>
  state.lastSeenAt !== null && now.getTime() - state.lastSeenAt.getTime() >= WICAN_QUIET_MS;

async function ingest(
  vehicleId: string,
  readings: WicanReadings,
  config: WicanConfig,
  now: Date,
): Promise<WicanOutcome> {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, deletedAt: null },
    select: { id: true, currentOdometerKm: true },
  });
  if (!vehicle) return "vehicle_not_found";

  let state: WicanState | null = await prisma.wicanVehicleState.findUnique({
    where: { vehicleId },
  });
  // First POST of a new trip before the sweep got to the last one.
  if (state && isQuiet(state, now) && state.pendingOdometerKm !== null) {
    await flushPending(state);
    state = { ...state, pendingOdometerKm: null };
  }

  let km: number;
  let anchor: Partial<WicanState> = {};
  if (readings.odometer !== null) {
    km = preferredToKm(readings.odometer, config.odometerUnit);
  } else if (readings.counterKm !== null) {
    const fromCounter = await odometerFromCounter(vehicle, state, readings.counterKm);
    if (!fromCounter) return "no_anchor";
    ({ km, anchor } = fromCounter);
  } else {
    return "no_reading";
  }

  // Odometers only go up; keep the trip's highest value.
  const pendingOdometerKm = Math.max(Math.round(km), state?.pendingOdometerKm ?? 0);
  const data = { pendingOdometerKm, lastSeenAt: now, ...anchor };
  await prisma.wicanVehicleState.upsert({
    where: { vehicleId },
    create: { vehicleId, ...data },
    update: data,
  });
  return "pending";
}

// The adapter posts every few seconds; serialise per vehicle so overlapping
// POSTs and the sweep never race on the same row.
const queues = new Map<string, Promise<unknown>>();

function serialised<T>(vehicleId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(vehicleId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  queues.set(vehicleId, run);
  void run
    .finally(() => {
      if (queues.get(vehicleId) === run) queues.delete(vehicleId);
    })
    .catch(() => {});
  return run;
}

export function ingestWicanReading(
  vehicleId: string,
  readings: WicanReadings,
  config: WicanConfig = wicanConfig(),
  now: Date = new Date(),
): Promise<WicanOutcome> {
  return serialised(vehicleId, () => ingest(vehicleId, readings, config, now));
}

/**
 * Saves the last value of every trip whose adapter has gone quiet. Run from
 * the background worker tick (instrumentation.ts). Returns how many were flushed.
 */
export async function flushQuietWicanTrips(now: Date = new Date()): Promise<number> {
  const quiet = await prisma.wicanVehicleState.findMany({
    where: {
      pendingOdometerKm: { not: null },
      lastSeenAt: { lte: new Date(now.getTime() - WICAN_QUIET_MS) },
    },
    select: { vehicleId: true },
  });
  for (const { vehicleId } of quiet) {
    await serialised(vehicleId, async () => {
      // Re-read inside the queue: a POST may have arrived meanwhile.
      const state = await prisma.wicanVehicleState.findUnique({ where: { vehicleId } });
      if (state && state.pendingOdometerKm !== null && isQuiet(state, now)) {
        await flushPending(state);
      }
    });
  }
  return quiet.length;
}
