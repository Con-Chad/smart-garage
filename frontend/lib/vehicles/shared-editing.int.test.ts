import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Services resolve the acting user themselves; let each test choose who that is.
const actor = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth/current-user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/current-user")>()),
  getCurrentUserId: async () => actor.userId,
}));

import { prisma } from "@/lib/prisma";
import { createFuelEntry, deleteFuelEntry, getFuelPageData } from "@/lib/services/fuel";
import { createExpense, deleteExpense, getExpensesPageData } from "@/lib/services/expenses";
import {
  deleteMaintenanceRecordEntry,
  getHistoryPageData,
  getScheduleDetailData,
  logMaintenanceService,
} from "@/lib/services/maintenance";
import { deleteVehicleDocument, uploadVehicleDocument } from "@/lib/services/documents";
import { createNoteForCurrentUser } from "@/lib/services/notes";
import {
  createSchedule,
  createUser,
  createVehicle,
  shareVehicle,
} from "@/test/integration/factories";

const uploadDir = mkdtempSync(path.join(tmpdir(), "sg-uploads-"));

describe("shared vehicles: editors write, viewers read (D-010)", () => {
  let owner: { id: string };
  let editor: { id: string };
  let viewer: { id: string };
  let stranger: { id: string };
  let vehicleId: string;
  let otherVehicleId: string;
  let scheduleId: string;

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDir;
    [owner, editor, viewer, stranger] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
      createUser(),
    ]);
    vehicleId = (await createVehicle(owner.id)).id;
    otherVehicleId = (await createVehicle(stranger.id)).id;
    await shareVehicle(vehicleId, editor.id, "EDITOR");
    await shareVehicle(vehicleId, viewer.id, "VIEWER");
    scheduleId = (await createSchedule(vehicleId)).id;
  });

  afterAll(() => {
    delete process.env.UPLOAD_DIR;
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const fillUp = (odometerKm: number) => ({
    vehicleId,
    filledAt: "2026-10-01",
    odometerKm,
    liters: 40,
    totalCostCents: 6000,
    currency: "USD",
  });

  it("lets an editor log fuel, which advances the odometer", async () => {
    actor.userId = editor.id;
    const id = await createFuelEntry(fillUp(12000));
    const entry = await prisma.fuelEntry.findUniqueOrThrow({ where: { id } });
    expect(entry.createdByUserId).toBe(editor.id);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(vehicle.currentOdometerKm).toBe(12000);
  });

  it("rejects fuel from viewers and strangers", async () => {
    for (const user of [viewer, stranger]) {
      actor.userId = user.id;
      await expect(createFuelEntry(fillUp(13000))).rejects.toThrow("VEHICLE_NOT_FOUND");
    }
  });

  it("shows shared fuel to viewers but not strangers", async () => {
    actor.userId = viewer.id;
    expect((await getFuelPageData()).entries.map((e) => e.vehicleId)).toContain(vehicleId);
    actor.userId = stranger.id;
    expect((await getFuelPageData()).entries).toEqual([]);
  });

  it("lets editors delete fuel but not viewers", async () => {
    actor.userId = owner.id;
    const id = await createFuelEntry(fillUp(12500));
    actor.userId = viewer.id;
    await expect(deleteFuelEntry(id)).rejects.toThrow("FUEL_ENTRY_NOT_FOUND");
    actor.userId = editor.id;
    await deleteFuelEntry(id);
    expect(await prisma.fuelEntry.findUnique({ where: { id } })).toBeNull();
  });

  it("handles expenses the same way", async () => {
    const expense = {
      vehicleId,
      category: "REPAIR" as const,
      occurredAt: "2026-10-02",
      amountCents: 12000,
    };
    actor.userId = viewer.id;
    await expect(createExpense(expense)).rejects.toThrow("VEHICLE_NOT_FOUND");
    actor.userId = editor.id;
    const id = await createExpense(expense);
    actor.userId = viewer.id;
    expect((await getExpensesPageData(vehicleId)).expenses.map((e) => e.id)).toContain(id);
    await expect(deleteExpense(id)).rejects.toThrow("EXPENSE_NOT_FOUND");
    actor.userId = editor.id;
    await deleteExpense(id);
  });

  it("refuses to link an expense to another vehicle's maintenance record", async () => {
    const foreignSchedule = await createSchedule(otherVehicleId);
    actor.userId = stranger.id;
    const foreignRecordId = await logMaintenanceService({
      scheduleId: foreignSchedule.id,
      performedAt: "2026-09-01",
      costCents: 0,
    });
    actor.userId = editor.id;
    await expect(
      createExpense({
        vehicleId,
        category: "REPAIR",
        occurredAt: "2026-10-02",
        amountCents: 100,
        maintenanceRecordId: foreignRecordId,
      }),
    ).rejects.toThrow("MAINTENANCE_RECORD_NOT_FOUND");
  });

  it("lets an editor log and delete a service; viewers can only read it", async () => {
    actor.userId = editor.id;
    const recordId = await logMaintenanceService(
      { scheduleId, performedAt: "2026-10-03", odometerKm: 12100, costCents: 4500 },
      [{ category: "ENGINE_OIL", name: "5W-30", quantity: 5, unit: "QUARTS" }],
    );
    const expense = await prisma.expense.findFirstOrThrow({
      where: { maintenanceRecordId: recordId },
    });
    expect(expense.createdByUserId).toBe(editor.id);

    actor.userId = viewer.id;
    await expect(
      logMaintenanceService({ scheduleId, performedAt: "2026-10-04", costCents: 0 }),
    ).rejects.toThrow("Schedule not found");
    const detail = await getScheduleDetailData(scheduleId, "en");
    expect(detail?.records.map((r) => r.id)).toEqual([recordId]);
    expect(detail?.records[0].items[0]).toMatchObject({ name: "5W-30", unit: "QUARTS" });
    const history = await getHistoryPageData("en");
    expect(history.records.map((r) => r.id)).toContain(recordId);
    await expect(deleteMaintenanceRecordEntry(recordId)).rejects.toThrow("Record not found");

    actor.userId = stranger.id;
    expect(await getScheduleDetailData(scheduleId, "en")).toBeNull();
    expect((await getHistoryPageData("en")).records.map((r) => r.id)).not.toContain(recordId);

    actor.userId = editor.id;
    await deleteMaintenanceRecordEntry(recordId);
    expect(await prisma.maintenanceRecord.findUnique({ where: { id: recordId } })).toBeNull();
  });

  it("lets editors upload and delete documents but not viewers", async () => {
    const pdf = () =>
      new File([Buffer.from("%PDF-1.4\n%test\n")], "receipt.pdf", {
        type: "application/pdf",
      });
    actor.userId = viewer.id;
    await expect(uploadVehicleDocument({ vehicleId, category: null }, pdf())).rejects.toThrow(
      "VEHICLE_NOT_FOUND",
    );
    actor.userId = editor.id;
    const id = await uploadVehicleDocument({ vehicleId, category: "INVOICE" }, pdf());
    actor.userId = viewer.id;
    await expect(deleteVehicleDocument(id)).rejects.toThrow("DOCUMENT_NOT_FOUND");
    actor.userId = editor.id;
    await deleteVehicleDocument(id);
  });

  it("lets anyone with access link a private note to the vehicle", async () => {
    actor.userId = viewer.id;
    const note = await createNoteForCurrentUser(
      { title: "Squeak", content: "", vehicleId, isPinned: false, tags: [] },
      "en",
    );
    expect(note.vehicleId).toBe(vehicleId);
    actor.userId = stranger.id;
    await expect(
      createNoteForCurrentUser(
        { title: "Nope", content: "", vehicleId, isPinned: false, tags: [] },
        "en",
      ),
    ).rejects.toThrow("Vehicle not found");
  });
});
