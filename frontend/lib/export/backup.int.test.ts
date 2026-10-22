import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { importUserBackup } from "@/lib/export/backup";
import { createUser, createVehicle } from "@/test/integration/factories";

/** Only the leading bytes matter to the sniffer. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

const uploadDir = mkdtempSync(path.join(tmpdir(), "sg-backup-import-"));

type Json = Record<string, unknown>;

function backup(overrides: Json = {}): Json {
  return {
    format: "smart-garage-user-backup",
    schemaVersion: 3,
    appVersion: "test",
    exportedAt: new Date().toISOString(),
    vehicles: [],
    maintenanceRecords: [],
    expenses: [],
    fuelEntries: [],
    documents: [],
    noteTags: [],
    notes: [],
    wishlistItems: [],
    odometerLogs: [],
    customFields: [],
    ...overrides,
  };
}

function vehicle(id: string): Json {
  return { id, make: "Own", model: "Car", currentOdometerKm: 1 };
}

function fuelEntry(id: string, vehicleId: string): Json {
  return { id, vehicleId, filledAt: new Date().toISOString(), totalCostCents: "100" };
}

function document(id: string, vehicleId: string | null, extra: Json = {}): Json {
  return {
    id,
    vehicleId,
    purpose: "OTHER",
    originalFilename: "r.jpg",
    mimeType: "image/jpeg",
    sizeBytes: String(JPEG.length),
    fileBase64: JPEG.toString("base64"),
    storageKey: `vehicles/${vehicleId}/documents/${id}.jpg`,
    ...extra,
  };
}

/** Everything the importer may have changed for a user, as one comparable snapshot. */
async function snapshot(userId: string) {
  const [vehicles, fuelEntries, documents, preferences] = await Promise.all([
    prisma.vehicle.findMany({ where: { ownerUserId: userId }, orderBy: { id: "asc" } }),
    prisma.fuelEntry.findMany({ where: { vehicle: { ownerUserId: userId } }, orderBy: { id: "asc" } }),
    prisma.document.findMany({ where: { vehicle: { ownerUserId: userId } }, orderBy: { id: "asc" } }),
    prisma.userPreferences.findUnique({ where: { userId } }),
  ]);
  return { vehicles, fuelEntries, documents, preferences };
}

describe("importUserBackup (S-1: no cross-user references)", () => {
  let victim: { id: string };
  let importer: { id: string };
  let victimVehicleId: string;

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDir;
    [victim, importer] = await Promise.all([createUser(), createUser()]);
    victimVehicleId = (await createVehicle(victim.id, { make: "Victim", model: "Car" })).id;
    await prisma.userPreferences.create({
      data: { userId: victim.id, backgroundImageKey: `users/${victim.id}/background.jpg`, backgroundMimeType: "image/jpeg" },
    });
  });

  afterAll(() => {
    delete process.env.UPLOAD_DIR;
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it("rejects child rows that name a vehicle the backup does not carry, changing nothing", async () => {
    // The importer already has data of their own; a bad file must not wipe it.
    await createVehicle(importer.id, { make: "Keep", model: "Me" });
    const before = { importer: await snapshot(importer.id), victim: await snapshot(victim.id) };

    const foreign = backup({
      vehicles: [vehicle("ownveh1")],
      fuelEntries: [fuelEntry("fuel1", "ownveh1"), fuelEntry("fuel2", victimVehicleId)],
    });
    await expect(importUserBackup(importer.id, foreign)).rejects.toThrow("INVALID_BACKUP");

    const foreignDocument = backup({
      vehicles: [vehicle("ownveh1")],
      documents: [document("doc1", victimVehicleId, { purpose: "VEHICLE_IMAGE" })],
    });
    await expect(importUserBackup(importer.id, foreignDocument)).rejects.toThrow("INVALID_BACKUP");

    const foreignRecordLink = backup({
      vehicles: [vehicle("ownveh1")],
      expenses: [
        { id: "exp1", vehicleId: "ownveh1", occurredAt: new Date().toISOString(), amountCents: "1", maintenanceRecordId: "someone-elses-record" },
      ],
    });
    await expect(importUserBackup(importer.id, foreignRecordLink)).rejects.toThrow("INVALID_BACKUP");

    const unsafeVehicleId = backup({ vehicles: [vehicle("../escape")] });
    await expect(importUserBackup(importer.id, unsafeVehicleId)).rejects.toThrow("INVALID_BACKUP");

    expect(await snapshot(importer.id)).toEqual(before.importer);
    expect(await snapshot(victim.id)).toEqual(before.victim);
    expect(await prisma.fuelEntry.count({ where: { vehicleId: victimVehicleId } })).toBe(0);
    expect(await prisma.vehicle.count({ where: { id: { in: ["ownveh1", "../escape"] } } })).toBe(0);
  });

  it("never uses the file's storageKey: documents are re-keyed under the imported vehicle", async () => {
    const victimBackground = path.join(uploadDir, "users", victim.id, "background.jpg");
    const file = backup({
      vehicles: [vehicle("ownveh2")],
      documents: [
        document("doc2", "ownveh2", { storageKey: `users/${victim.id}/background.jpg` }),
        document("doc3", "ownveh2", { storageKey: "../../etc/passwd" }),
        document("doc4", null, { storageKey: `vehicles/${victimVehicleId}/documents/x.jpg` }),
      ],
      preferences: {
        theme: "dark",
        backgroundImageKey: `users/${victim.id}/background.jpg`,
        backgroundMimeType: "image/jpeg",
      },
    });

    const summary = await importUserBackup(importer.id, file);
    expect(summary.documents).toBe(3);

    const docs = await prisma.document.findMany({ where: { uploadedByUserId: importer.id }, orderBy: { id: "asc" } });
    expect(docs.map((d) => d.id)).toEqual(["doc2", "doc3", "doc4"]);
    for (const doc of docs) {
      expect(doc.storageBackend).toBe("local");
      expect(doc.storageKey).not.toContain("..");
      expect(doc.storageKey).not.toContain(victim.id);
      expect(doc.storageKey).not.toContain(victimVehicleId);
      expect(existsSync(path.join(uploadDir, doc.storageKey))).toBe(true);
    }
    expect(docs[0].storageKey).toMatch(/^vehicles\/ownveh2\/documents\/[0-9a-f-]{36}\.jpg$/);
    expect(docs[2].storageKey).toMatch(new RegExp(`^users/${importer.id}/documents/[0-9a-f-]{36}\\.jpg$`));

    // Nothing landed in the victim's folders.
    expect(existsSync(victimBackground)).toBe(false);
    expect(existsSync(path.join(uploadDir, "vehicles", victimVehicleId))).toBe(false);
    expect(readdirSync(uploadDir).sort()).toEqual(["users", "vehicles"]);

    // A background key outside the importer's own folder is dropped rather than copied.
    const prefs = await prisma.userPreferences.findUniqueOrThrow({ where: { userId: importer.id } });
    expect(prefs.theme).toBe("dark");
    expect(prefs.backgroundImageKey).toBeNull();
    expect(prefs.backgroundMimeType).toBeNull();
    const victimPrefs = await prisma.userPreferences.findUniqueOrThrow({ where: { userId: victim.id } });
    expect(victimPrefs.backgroundImageKey).toBe(`users/${victim.id}/background.jpg`);
  });

  it("keeps the importer's own background key and sanitises file names", async () => {
    const file = backup({
      vehicles: [vehicle("ownveh3")],
      documents: [document("doc5", "ownveh3", { originalFilename: "re\u0000ceipt\n.jpg" })],
      preferences: { backgroundImageKey: `users/${importer.id}/background.png`, backgroundMimeType: "image/png" },
    });
    await importUserBackup(importer.id, file);

    const prefs = await prisma.userPreferences.findUniqueOrThrow({ where: { userId: importer.id } });
    expect(prefs.backgroundImageKey).toBe(`users/${importer.id}/background.png`);
    expect(prefs.backgroundMimeType).toBe("image/png");
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: "doc5" } });
    expect(doc.originalFilename).toBe("receipt.jpg");
  });

  it("rejects files whose bytes do not match the declared type, or whose type is not allowed", async () => {
    const before = await snapshot(importer.id);

    const mislabeled = backup({
      vehicles: [vehicle("ownveh4")],
      documents: [document("doc6", "ownveh4", { mimeType: "image/jpeg", fileBase64: PNG.toString("base64") })],
    });
    await expect(importUserBackup(importer.id, mislabeled)).rejects.toThrow("INVALID_BACKUP");

    const html = backup({
      vehicles: [vehicle("ownveh4")],
      documents: [
        document("doc7", "ownveh4", { mimeType: "text/html", fileBase64: Buffer.from("<script>").toString("base64") }),
      ],
    });
    await expect(importUserBackup(importer.id, html)).rejects.toThrow("INVALID_BACKUP");

    const badPurpose = backup({
      vehicles: [vehicle("ownveh4")],
      documents: [document("doc8", "ownveh4", { purpose: "ADMIN_OVERRIDE" })],
    });
    await expect(importUserBackup(importer.id, badPurpose)).rejects.toThrow("INVALID_BACKUP");

    expect(await snapshot(importer.id)).toEqual(before);
    expect(await prisma.document.count({ where: { id: { in: ["doc6", "doc7", "doc8"] } } })).toBe(0);
  });

  it("still restores a well-formed backup with every reference inside it", async () => {
    const file = backup({
      vehicles: [{ ...vehicle("ownveh5"), maintenanceSchedules: [{ id: "sched5", customName: "Oil", category: "OTHER" }] }],
      maintenanceRecords: [{ id: "rec5", vehicleId: "ownveh5", scheduleId: "sched5", performedAt: new Date().toISOString(), costCents: "10" }],
      expenses: [{ id: "exp5", vehicleId: "ownveh5", maintenanceRecordId: "rec5", occurredAt: new Date().toISOString(), amountCents: "10" }],
      fuelEntries: [fuelEntry("fuel5", "ownveh5")],
      documents: [document("doc9", "ownveh5", { maintenanceRecordId: "rec5", fuelEntryId: "fuel5", purpose: "RECEIPT" })],
      noteTags: [{ id: "tag5", name: "t" }],
      notes: [{ id: "note5", title: "n", vehicleId: "ownveh5", maintenanceRecordId: "rec5", tagIds: ["tag5"] }],
      odometerLogs: [{ id: "odo5", vehicleId: "ownveh5", odometerKm: 5 }],
      wishlistItems: [{ id: "wish5", vehicleId: "ownveh5", title: "w" }],
    });
    const summary = await importUserBackup(importer.id, file);
    expect(summary).toMatchObject({ vehicles: 1, maintenanceRecords: 1, expenses: 1, fuelEntries: 1, documents: 1, notes: 1 });

    const doc = await prisma.document.findUniqueOrThrow({ where: { id: "doc9" } });
    expect(doc).toMatchObject({ vehicleId: "ownveh5", maintenanceRecordId: "rec5", fuelEntryId: "fuel5", purpose: "RECEIPT" });
    expect(await prisma.vehicle.count({ where: { ownerUserId: importer.id } })).toBe(1);
    // Earlier imports' files were removed from disk along with their rows.
    expect(await prisma.document.count({ where: { uploadedByUserId: importer.id } })).toBe(1);
  });
});
