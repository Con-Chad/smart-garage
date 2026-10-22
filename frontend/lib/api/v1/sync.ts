import type { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decodeCursor, encodeCursor, syncCursorSchema } from "@/lib/api/v1/cursor";
import {
  RESOURCES,
  RESOURCE_KEYS,
  type ApiRow,
  type ChangeContext,
  type ResourceKey,
} from "@/lib/api/v1/resources";
import { vehiclesSharedSince, type ApiScope } from "@/lib/api/v1/scope";

/**
 * Incremental sync for offline clients.
 *
 * A sync session starts at `serverTime`. Every page returns rows changed
 * after `since` (all rows when there is no `since`) and up to `serverTime`,
 * walking the resources in registry order and each one by (updatedAt, id).
 * The last page adds `deletions`. The client stores `nextSince` and passes it
 * as `?since=` next time; rows changed while paging are picked up then.
 *
 * `fullResync: true` means the response is the complete data set: the client
 * clears its local copy before applying it. That happens on a first sync, when
 * `since` is older than the tombstone retention, and after a backup import.
 */

export const SYNC_RETENTION_DAYS = 90;
/** Re-read a few seconds before `since`, so a write committed just as the
 * previous sync started is not missed. Upserts are idempotent. */
const OVERLAP_MS = 5000;
export const DEFAULT_SYNC_PAGE_SIZE = 500;
export const MAX_SYNC_PAGE_SIZE = 1000;

type SyncCursor = z.infer<typeof syncCursorSchema>;

const TOMBSTONE_TARGETS: Record<string, ResourceKey> = {
  vehicle: "vehicles",
  vehicleAccess: "vehicles",
  modification: "modifications",
  customField: "customFields",
  customFieldValue: "customFieldValues",
  schedule: "schedules",
  maintenanceRecord: "maintenanceRecords",
  fuelEntry: "fuelEntries",
  odometerLog: "odometerLogs",
  expense: "expenses",
  document: "documents",
  inspection: "inspections",
  insurancePolicy: "insurancePolicies",
  note: "notes",
  wishlistItem: "wishlistItems",
};

export type SyncPage = {
  serverTime: string;
  fullResync: boolean;
  hasMore: boolean;
  cursor: string | null;
  nextSince: string | null;
  changes: Partial<Record<ResourceKey, unknown[]>>;
  deletions: Partial<Record<ResourceKey, string[]>>;
};

export class InvalidSyncCursorError extends Error {}

export async function runSync(input: {
  scope: ApiScope;
  since: Date | null;
  cursor: string | null;
  limit: number;
  now?: Date;
}): Promise<SyncPage> {
  const { scope, limit } = input;
  let state: SyncCursor;

  if (input.cursor) {
    const decoded = decodeCursor(input.cursor, syncCursorSchema);
    if (!decoded) throw new InvalidSyncCursorError();
    state = decoded;
  } else {
    const now = input.now ?? new Date();
    const fullResync = await needsFullResync(scope, input.since, now);
    state = {
      v: 1,
      s: fullResync || !input.since ? null : input.since.toISOString(),
      t: now.toISOString(),
      f: fullResync,
      e: 0,
      u: null,
      i: null,
    };
  }

  const serverTime = new Date(state.t);
  const lower = state.s ? new Date(new Date(state.s).getTime() - OVERLAP_MS) : null;
  const newlySharedVehicleIds = lower ? vehiclesSharedSince(scope, lower) : [];
  const ctx: ChangeContext = {
    scope,
    newlySharedVehicleIds,
    newSharerIds: [
      ...new Set(
        newlySharedVehicleIds
          .map((id) => scope.grants.get(id)?.ownerUserId)
          .filter((id): id is string => !!id && id !== scope.userId),
      ),
    ],
  };

  const changes: SyncPage["changes"] = {};
  let budget = limit;
  let position = { e: state.e, u: state.u, i: state.i };

  while (position.e < RESOURCE_KEYS.length) {
    if (budget === 0) {
      return page(state, position, changes, {});
    }
    const key = RESOURCE_KEYS[position.e];
    const def = RESOURCES[key];

    const conditions: object[] = [def.visible(scope), { updatedAt: { lte: serverTime } }];
    if (lower) {
      conditions.push({
        OR: [{ updatedAt: { gt: lower } }, ...(def.alsoChangedSince?.(lower, ctx) ?? [])],
      });
    }
    if (position.u && position.i) {
      const after = new Date(position.u);
      conditions.push({
        OR: [{ updatedAt: { gt: after } }, { updatedAt: after, id: { gt: position.i } }],
      });
    }

    const rows: ApiRow[] = await def.find({
      where: { AND: conditions },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: budget + 1,
    });

    const emitted = rows.slice(0, budget);
    if (emitted.length > 0) {
      changes[key] = emitted.map((row) => def.toApi(row, scope));
    }

    if (rows.length > budget) {
      const last = emitted[emitted.length - 1];
      return page(
        state,
        { e: position.e, u: last.updatedAt.toISOString(), i: last.id },
        changes,
        {},
      );
    }

    budget -= emitted.length;
    position = { e: position.e + 1, u: null, i: null };
  }

  const deletions = lower ? await collectDeletions(scope, lower) : {};
  return page(state, position, changes, deletions, true);
}

function page(
  state: SyncCursor,
  position: { e: number; u: string | null; i: string | null },
  changes: SyncPage["changes"],
  deletions: SyncPage["deletions"],
  done = false,
): SyncPage {
  return {
    serverTime: state.t,
    fullResync: state.f,
    hasMore: !done,
    cursor: done ? null : encodeCursor({ ...state, ...position }),
    nextSince: done ? state.t : null,
    changes,
    deletions,
  };
}

async function needsFullResync(scope: ApiScope, since: Date | null, now: Date) {
  if (!since) return true;
  const retentionStart = now.getTime() - SYNC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  if (since.getTime() < retentionStart) return true;

  // A backup import by this user, or by the owner of a vehicle shared with them.
  const reset = await prisma.syncTombstone.findFirst({
    where: {
      entity: "*",
      deletedAt: { gt: new Date(since.getTime() - OVERLAP_MS) },
      userId: { in: [scope.userId, ...scope.sharerIds] },
    },
    select: { id: true },
  });
  return reset != null;
}

async function collectDeletions(scope: ApiScope, lower: Date) {
  const deleted = new Map<ResourceKey, Set<string>>();
  const add = (key: ResourceKey, id: string) => {
    const ids = deleted.get(key) ?? new Set<string>();
    ids.add(id);
    deleted.set(key, ids);
  };

  const [tombstones, softDeletedVehicles, softDeletedDocuments, inactiveSchedules] =
    await Promise.all([
      prisma.syncTombstone.findMany({
        where: {
          deletedAt: { gt: lower },
          OR: [
            { vehicleId: { in: scope.vehicleIds } },
            { userId: scope.userId },
            { entity: "customField", userId: { in: scope.sharerIds } },
          ],
        },
        select: { entity: true, entityId: true },
      }),
      prisma.vehicle.findMany({
        where: {
          deletedAt: { gt: lower },
          OR: [{ ownerUserId: scope.userId }, { shares: { some: { userId: scope.userId } } }],
        },
        select: { id: true },
      }),
      prisma.document.findMany({
        where: {
          deletedAt: { gt: lower },
          OR: [{ vehicleId: { in: scope.vehicleIds } }, { uploadedByUserId: scope.userId }],
        },
        select: { id: true },
      }),
      prisma.vehicleMaintenanceSchedule.findMany({
        where: { isActive: false, updatedAt: { gt: lower }, vehicleId: { in: scope.vehicleIds } },
        select: { id: true },
      }),
    ]);

  for (const tombstone of tombstones) {
    const key = TOMBSTONE_TARGETS[tombstone.entity];
    if (key) add(key, tombstone.entityId);
  }
  for (const row of softDeletedVehicles) add("vehicles", row.id);
  for (const row of softDeletedDocuments) add("documents", row.id);
  for (const row of inactiveSchedules) add("schedules", row.id);

  // Access removed and granted again within the window: the vehicle stays.
  const vehicleIds = deleted.get("vehicles");
  if (vehicleIds) {
    for (const id of scope.vehicleIds) vehicleIds.delete(id);
  }

  const result: SyncPage["deletions"] = {};
  for (const [key, ids] of deleted) {
    if (ids.size > 0) result[key] = [...ids];
  }
  return result;
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneState = globalThis as unknown as { syncTombstonesPrunedAt?: number };

/** Drops tombstones past the retention window, at most once an hour per process. */
export async function pruneSyncTombstones(now = new Date()): Promise<void> {
  const last = pruneState.syncTombstonesPrunedAt ?? 0;
  if (now.getTime() - last < PRUNE_INTERVAL_MS) return;
  pruneState.syncTombstonesPrunedAt = now.getTime();

  const cutoff = new Date(now.getTime() - SYNC_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.syncTombstone.deleteMany({ where: { deletedAt: { lt: cutoff } } });
}
