import type { VehicleShareRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Minimal rows for integration tests; override only what a test cares about. */
export async function createUser(overrides: { username?: string } = {}) {
  const username = overrides.username ?? `user_${randomUUID().slice(0, 8)}`;
  return prisma.user.create({
    data: {
      username,
      email: `${username}@smart-garage.local`,
      // Never verified in these tests; real hashes come from lib/auth/password.
      passwordHash: "test:not-a-real-hash",
    },
  });
}

export async function createVehicle(
  ownerUserId: string,
  overrides: { make?: string; model?: string; deletedAt?: Date } = {},
) {
  return prisma.vehicle.create({
    data: {
      ownerUserId,
      make: overrides.make ?? "Test",
      model: overrides.model ?? "Car",
      deletedAt: overrides.deletedAt,
    },
  });
}

export async function shareVehicle(
  vehicleId: string,
  userId: string,
  role: VehicleShareRole,
) {
  return prisma.vehicleShare.create({ data: { vehicleId, userId, role } });
}
