import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { refreshScheduleDueStatus } from "@/lib/repositories/maintenance";
import { createSchedule, createUser, createVehicle } from "@/test/integration/factories";

describe("refreshScheduleDueStatus", () => {
  it("writes only when the derived due status actually changes", async () => {
    const user = await createUser();
    const vehicle = await createVehicle(user.id);
    const schedule = await createSchedule(vehicle.id, { intervalKm: 10000 });
    await prisma.maintenanceRecord.create({
      data: {
        vehicleId: vehicle.id,
        scheduleId: schedule.id,
        performedAt: new Date("2026-01-01"),
        odometerKm: 5000,
        createdByUserId: user.id,
      },
    });

    await refreshScheduleDueStatus(prisma, schedule.id);
    const first = await prisma.vehicleMaintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(first.nextDueOdometerKm).toBe(15000);

    // Same inputs: no write, so API sync doesn't see a phantom change.
    await refreshScheduleDueStatus(prisma, schedule.id);
    const second = await prisma.vehicleMaintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());

    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { currentOdometerKm: 16000 } });
    await refreshScheduleDueStatus(prisma, schedule.id);
    const third = await prisma.vehicleMaintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(third.dueStatus).toBe("OVERDUE");
  });
});
