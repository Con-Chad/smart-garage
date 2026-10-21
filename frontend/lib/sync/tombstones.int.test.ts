import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createSchedule,
  createUser,
  createVehicle,
  shareVehicle,
} from "@/test/integration/factories";

async function tombstonesFor(entityId: string) {
  return prisma.syncTombstone.findMany({ where: { entityId } });
}

describe("SyncTombstone triggers", () => {
  let owner: { id: string };
  let friend: { id: string };

  beforeAll(async () => {
    [owner, friend] = await Promise.all([createUser(), createUser()]);
  });

  it("records a direct delete with its vehicle scope", async () => {
    const vehicle = await createVehicle(owner.id);
    const entry = await prisma.fuelEntry.create({
      data: {
        vehicleId: vehicle.id,
        filledAt: new Date(),
        totalCostCents: BigInt(100),
        createdByUserId: owner.id,
      },
    });
    const before = Date.now();
    await prisma.fuelEntry.delete({ where: { id: entry.id } });

    const [tombstone] = await tombstonesFor(entry.id);
    expect(tombstone).toMatchObject({ entity: "fuelEntry", vehicleId: vehicle.id, userId: null });
    // Same integer-millisecond encoding Prisma uses, so it reads back as a real date.
    expect(tombstone.deletedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(tombstone.deletedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("records rows removed by FK cascades", async () => {
    const vehicle = await createVehicle(owner.id);
    const schedule = await createSchedule(vehicle.id);
    const log = await prisma.odometerLog.create({
      data: { vehicleId: vehicle.id, odometerKm: 1, createdByUserId: owner.id },
    });
    await prisma.vehicle.delete({ where: { id: vehicle.id } });

    expect((await tombstonesFor(schedule.id)).map((t) => t.entity)).toEqual(["schedule"]);
    expect((await tombstonesFor(log.id)).map((t) => t.entity)).toEqual(["odometerLog"]);
    expect((await tombstonesFor(vehicle.id)).map((t) => t.entity)).toEqual(["vehicle"]);
  });

  it("records a removed share as lost access for that user only", async () => {
    const vehicle = await createVehicle(owner.id);
    const share = await shareVehicle(vehicle.id, friend.id, "VIEWER");
    await prisma.vehicleShare.delete({ where: { id: share.id } });

    const [tombstone] = await tombstonesFor(vehicle.id);
    expect(tombstone).toMatchObject({
      entity: "vehicleAccess",
      vehicleId: null,
      userId: friend.id,
    });
  });

  it("records user-owned rows by user", async () => {
    const note = await prisma.note.create({
      data: { ownerUserId: owner.id, title: "t", content: "" },
    });
    await prisma.note.delete({ where: { id: note.id } });
    expect((await tombstonesFor(note.id))[0]).toMatchObject({
      entity: "note",
      userId: owner.id,
      vehicleId: null,
    });
  });
});
