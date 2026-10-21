import type { VehicleShareRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type VehicleRole = "OWNER" | VehicleShareRole;

export type VehicleGrant = {
  role: VehicleRole;
  canEdit: boolean;
  ownerUserId: string;
  /** When the share was created (null for owned vehicles). */
  sharedAt: Date | null;
  /** Last change to the share itself, e.g. a role change. */
  shareUpdatedAt: Date | null;
};

/**
 * Everything the API needs to know about what one user may see, resolved
 * once per request. The same rules as `lib/vehicles/access.ts`: own
 * vehicles plus vehicles shared with the user, never soft-deleted ones.
 */
export type ApiScope = {
  userId: string;
  grants: Map<string, VehicleGrant>;
  /** Ids of every vehicle the user can see. */
  vehicleIds: string[];
  /** Owners of vehicles shared with the user (their custom-field definitions apply). */
  sharerIds: string[];
};

export async function loadApiScope(userId: string): Promise<ApiScope> {
  const [owned, shares] = await Promise.all([
    prisma.vehicle.findMany({
      where: { ownerUserId: userId, deletedAt: null },
      select: { id: true },
    }),
    prisma.vehicleShare.findMany({
      where: { userId, vehicle: { deletedAt: null } },
      select: {
        vehicleId: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        vehicle: { select: { ownerUserId: true } },
      },
    }),
  ]);

  const grants = new Map<string, VehicleGrant>();
  for (const share of shares) {
    grants.set(share.vehicleId, {
      role: share.role,
      canEdit: share.role === "EDITOR",
      ownerUserId: share.vehicle.ownerUserId,
      sharedAt: share.createdAt,
      shareUpdatedAt: share.updatedAt,
    });
  }
  for (const vehicle of owned) {
    grants.set(vehicle.id, {
      role: "OWNER",
      canEdit: true,
      ownerUserId: userId,
      sharedAt: null,
      shareUpdatedAt: null,
    });
  }

  const sharerIds = new Set<string>();
  for (const grant of grants.values()) {
    if (grant.ownerUserId !== userId) sharerIds.add(grant.ownerUserId);
  }

  return { userId, grants, vehicleIds: [...grants.keys()], sharerIds: [...sharerIds] };
}

/** Vehicles that became visible to the user after `since` (new shares). */
export function vehiclesSharedSince(scope: ApiScope, since: Date): string[] {
  const ids: string[] = [];
  for (const [vehicleId, grant] of scope.grants) {
    if (grant.sharedAt && grant.sharedAt > since) ids.push(vehicleId);
  }
  return ids;
}
