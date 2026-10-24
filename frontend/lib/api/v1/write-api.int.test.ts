import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ headers: new Headers(), session: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) => (request.session ? { name, value: request.session } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

import { prisma } from "@/lib/prisma";
import { createApiDevice } from "@/lib/repositories/api-devices";
import { createSession } from "@/lib/auth/session";
import { GET as listFuel } from "@/app/api/v1/fuel/route";
import { POST as createFuel } from "@/app/api/v1/fuel/route";
import { DELETE as deleteFuel } from "@/app/api/v1/fuel/[id]/route";
import { POST as createExpense } from "@/app/api/v1/expenses/route";
import { POST as createOdometer } from "@/app/api/v1/odometer/route";
import { POST as createRecord } from "@/app/api/v1/records/route";
import { PATCH as patchRecord } from "@/app/api/v1/records/[id]/route";
import { PATCH as patchSchedule } from "@/app/api/v1/schedules/[id]/route";
import { POST as createDocument } from "@/app/api/v1/documents/route";
import { POST as createVehicle } from "@/app/api/v1/vehicles/route";
import { PATCH as patchVehicle, DELETE as deleteVehicle } from "@/app/api/v1/vehicles/[id]/route";
import { POST as createNote } from "@/app/api/v1/notes/route";
import { PATCH as patchNote } from "@/app/api/v1/notes/[id]/route";
import { PATCH as patchCustomField } from "@/app/api/v1/custom-fields/[id]/route";
import { POST as createShare } from "@/app/api/v1/vehicles/[id]/shares/route";
import { PATCH as patchPreferences } from "@/app/api/v1/preferences/route";
import { PATCH as patchNotifications } from "@/app/api/v1/notification-settings/route";
import { GET as sync } from "@/app/api/v1/sync/route";
import { GET as listOdometer } from "@/app/api/v1/odometer/route";
import { getFuelPageData } from "@/lib/services/fuel";
import {
  createSchedule,
  createUser,
  createVehicle as createVehicleRow,
  shareVehicle,
} from "@/test/integration/factories";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tokens = new Map<string, string>();
async function as(userId: string, extra: Record<string, string> = {}) {
  if (!tokens.has(userId)) {
    tokens.set(userId, (await createApiDevice({ userId, name: "test" })).token);
  }
  request.headers = new Headers({ authorization: `Bearer ${tokens.get(userId)}`, ...extra });
}

const url = (p: string) => `http://test/api/v1/${p}`;
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/** A JSON request whose headers match what the mocked `next/headers` returns. */
function jsonRequest(method: string, p: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url(p), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

function upload(fields: Record<string, string>, file: { bytes: Buffer; name: string; type: string }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return new Request(url("documents"), { method: "POST", body: form });
}

const uploadDir = mkdtempSync(path.join(tmpdir(), "sg-write-api-"));

describe("API v1 write endpoints", () => {
  let owner: { id: string };
  let editor: { id: string };
  let viewer: { id: string };
  let stranger: { id: string };
  let vehicleId: string;
  let scheduleId: string;

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDir;
    process.env.MAX_UPLOAD_SIZE_MB = "1";
    [owner, editor, viewer, stranger] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
      createUser(),
    ]);
    vehicleId = (await createVehicleRow(owner.id, { make: "Mazda", model: "CX-5" })).id;
    await shareVehicle(vehicleId, editor.id, "EDITOR");
    await shareVehicle(vehicleId, viewer.id, "VIEWER");
    scheduleId = (await createSchedule(vehicleId, { customName: "Oil change", intervalKm: 8000 })).id;
  });

  afterAll(() => {
    delete process.env.UPLOAD_DIR;
    delete process.env.MAX_UPLOAD_SIZE_MB;
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const fillUp = (overrides: Record<string, unknown> = {}) => ({
    vehicleId,
    filledAt: "2026-10-01T15:00:00.000Z",
    odometerKm: 50_000,
    liters: 45.2,
    totalCostCents: 14_250,
    currency: "USD",
    stationName: "Costco",
    ...overrides,
  });

  it("rejects writes without a device token, even with a web session", async () => {
    request.headers = new Headers();
    expect((await createFuel(jsonRequest("POST", "fuel", fillUp()))).status).toBe(401);

    request.session = await createSession(owner.id, false);
    try {
      // The session works for reads, so the 401 below is the write rule.
      expect((await listFuel(new Request(url("fuel")))).status).toBe(200);
      expect((await createFuel(jsonRequest("POST", "fuel", fillUp()))).status).toBe(401);
    } finally {
      request.session = null;
    }
  });

  it("creates a fill-up that the web UI's fuel page shows", async () => {
    await as(owner.id);
    const response = await createFuel(jsonRequest("POST", "fuel", fillUp()));
    expect(response.status).toBe(201);
    const entry = await json(response);
    expect(entry).toMatchObject({ vehicleId, liters: 45.2, totalCostCents: 14_250, stationName: "Costco" });

    // The same service the /fuel page renders from.
    const page = await getFuelPageData(vehicleId);
    expect(page.entries.map((row) => row.id)).toContain(entry.id);

    // Moving the odometer forward is part of the shared business rules.
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(vehicle.currentOdometerKm).toBe(50_000);
  });

  it("lets a shared editor write, gives a viewer 403 and a stranger 404", async () => {
    await as(editor.id);
    expect((await createFuel(jsonRequest("POST", "fuel", fillUp({ odometerKm: 50_100 })))).status).toBe(201);

    await as(viewer.id);
    const viewerResponse = await createFuel(jsonRequest("POST", "fuel", fillUp()));
    expect(viewerResponse.status).toBe(403);
    expect((await json(viewerResponse)).error.code).toBe("forbidden");
    expect(
      (await createOdometer(jsonRequest("POST", "odometer", { vehicleId, odometerKm: 60_000 }))).status,
    ).toBe(403);
    expect(
      (await patchSchedule(jsonRequest("PATCH", `schedules/${scheduleId}`, { intervalKm: 1 }), params({ id: scheduleId }))).status,
    ).toBe(403);

    await as(stranger.id);
    expect((await createFuel(jsonRequest("POST", "fuel", fillUp()))).status).toBe(404);
    expect(
      (await patchSchedule(jsonRequest("PATCH", `schedules/${scheduleId}`, { intervalKm: 1 }), params({ id: scheduleId }))).status,
    ).toBe(404);

    const entry = await prisma.fuelEntry.findFirstOrThrow({ where: { vehicleId } });
    await as(viewer.id);
    expect((await deleteFuel(new Request(url(`fuel/${entry.id}`), { method: "DELETE" }), params({ id: entry.id }))).status).toBe(403);
    await as(stranger.id);
    expect((await deleteFuel(new Request(url(`fuel/${entry.id}`), { method: "DELETE" }), params({ id: entry.id }))).status).toBe(404);
    expect(await prisma.fuelEntry.count({ where: { id: entry.id } })).toBe(1);
  });

  it("keeps vehicle deletion and sharing to the owner", async () => {
    await as(editor.id);
    expect((await deleteVehicle(new Request(url(`vehicles/${vehicleId}`), { method: "DELETE" }), params({ id: vehicleId }))).status).toBe(403);
    expect(
      (await createShare(jsonRequest("POST", `vehicles/${vehicleId}/shares`, { username: "x" }), params({ id: vehicleId }))).status,
    ).toBe(403);

    // But editors may change the vehicle's details (D-010).
    const patched = await patchVehicle(
      jsonRequest("PATCH", `vehicles/${vehicleId}`, { licensePlate: "ABC 123", color: "Soul Red" }),
      params({ id: vehicleId }),
    );
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ licensePlate: "ABC 123", color: "Soul Red", make: "Mazda" });
  });

  it("validates bodies with 400 for broken JSON and 422 with field paths", async () => {
    await as(owner.id);
    const broken = new Request(url("fuel"), { method: "POST", body: "{not json" });
    expect((await createFuel(broken)).status).toBe(400);

    const invalid = await createFuel(jsonRequest("POST", "fuel", fillUp({ totalCostCents: -5, filledAt: "soon" })));
    expect(invalid.status).toBe(422);
    const paths = (await json(invalid)).error.issues.map((issue: Json) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["totalCostCents", "filledAt"]));
  });

  it("bounds vehicle numbers that would otherwise sync absurd values to every client (S-9)", async () => {
    await as(owner.id);
    const base = { make: "Toyota", model: "Tacoma", productionYear: 2021, currentOdometerKm: 1 };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["productionYear", { productionYear: 99_999 }],
      ["productionYear", { productionYear: 1800 }],
      ["powerKw", { powerKw: 1_000_000 }],
      ["powerPs", { powerPs: -1 }],
      ["torqueNm", { torqueNm: 10 ** 9 }],
      ["displacementCc", { displacementCc: 10 ** 12 }],
    ];
    for (const [field, override] of cases) {
      const response = await createVehicle(jsonRequest("POST", "vehicles", { ...base, ...override }));
      expect(response.status, field).toBe(422);
      const paths = (await json(response)).error.issues.map((issue: Json) => issue.path);
      expect(paths, field).toContain(field);
    }
    const ok = await createVehicle(
      jsonRequest("POST", "vehicles", { ...base, powerKw: 150, powerPs: 204, torqueNm: 400, displacementCc: 2487 }),
    );
    expect(ok.status).toBe(201);
  });

  describe("Idempotency-Key", () => {
    it("replays the stored response instead of writing twice", async () => {
      await as(owner.id);
      const headers = { "idempotency-key": "outbox-0001-fuel" };
      const first = await createFuel(jsonRequest("POST", "fuel", fillUp({ note: "once" }), headers));
      expect(first.status).toBe(201);
      const firstBody = await json(first);

      const retry = await createFuel(jsonRequest("POST", "fuel", fillUp({ note: "once" }), headers));
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect((await json(retry)).id).toBe(firstBody.id);
      expect(await prisma.fuelEntry.count({ where: { note: "once" } })).toBe(1);
    });

    it("rejects a key reused for a different request", async () => {
      await as(owner.id);
      const headers = { "idempotency-key": "outbox-0002-fuel" };
      expect((await createFuel(jsonRequest("POST", "fuel", fillUp({ note: "a" }), headers))).status).toBe(201);
      const reused = await createFuel(jsonRequest("POST", "fuel", fillUp({ note: "b" }), headers));
      expect(reused.status).toBe(422);
      expect((await json(reused)).error.code).toBe("idempotency_key_reused");
    });

    it("scopes keys per user", async () => {
      const headers = { "idempotency-key": "outbox-0003-shared" };
      await as(owner.id);
      expect((await createFuel(jsonRequest("POST", "fuel", fillUp({ note: "owner" }), headers))).status).toBe(201);
      await as(editor.id);
      const other = await createFuel(jsonRequest("POST", "fuel", fillUp({ note: "editor" }), headers));
      expect(other.status).toBe(201);
      expect(other.headers.get("idempotent-replayed")).toBeNull();
    });

    it("replays a final 4xx answer too", async () => {
      await as(viewer.id);
      const headers = { "idempotency-key": "outbox-0004-denied" };
      expect((await createFuel(jsonRequest("POST", "fuel", fillUp(), headers))).status).toBe(403);
      const again = await createFuel(jsonRequest("POST", "fuel", fillUp(), headers));
      expect(again.status).toBe(403);
      expect(again.headers.get("idempotent-replayed")).toBe("true");
    });

    it("treats a multipart retry with a new boundary as the same request", async () => {
      await as(owner.id);
      const headers = { "idempotency-key": "outbox-0005-upload" };
      const send = () => {
        const req = upload({ vehicleId, title: "Receipt" }, { bytes: PNG, name: "r.png", type: "image/png" });
        for (const [key, value] of Object.entries(headers)) req.headers.set(key, value);
        return createDocument(req);
      };
      const first = await send();
      expect(first.status).toBe(201);
      const retry = await send();
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect((await json(retry)).id).toBe((await json(first)).id);
    });
  });

  describe("uploads", () => {
    it("stores an allowed file without exposing storage internals", async () => {
      await as(editor.id);
      const response = await createDocument(
        upload({ vehicleId, category: "INVOICE", title: "Tires" }, { bytes: PNG, name: "t.png", type: "image/png" }),
      );
      expect(response.status).toBe(201);
      const body = await json(response);
      expect(body).toMatchObject({ vehicleId, title: "Tires", mimeType: "image/png" });
      expect(body).not.toHaveProperty("storageKey");
    });

    it("rejects files over the limit with 413", async () => {
      await as(owner.id);
      const big = Buffer.concat([PNG, Buffer.alloc(1_200_000)]);
      const response = await createDocument(upload({ vehicleId }, { bytes: big, name: "big.png", type: "image/png" }));
      expect(response.status).toBe(413);
    });

    it("rejects disallowed types and content that doesn't match its type with 415", async () => {
      await as(owner.id);
      const script = Buffer.from("<script>alert(1)</script>");
      expect(
        (await createDocument(upload({ vehicleId }, { bytes: script, name: "x.html", type: "text/html" }))).status,
      ).toBe(415);
      expect(
        (await createDocument(upload({ vehicleId }, { bytes: script, name: "x.png", type: "image/png" }))).status,
      ).toBe(415);
      expect(
        (await createDocument(jsonRequest("POST", "documents", { vehicleId }))).status,
      ).toBe(415);
    });

    it("gives a viewer 403 on upload", async () => {
      await as(viewer.id);
      const response = await createDocument(upload({ vehicleId }, { bytes: PNG, name: "v.png", type: "image/png" }));
      expect(response.status).toBe(403);
    });
  });

  describe("maintenance", () => {
    it("logs a service with parts, adds the expense and keeps fields on PATCH", async () => {
      await as(owner.id);
      const created = await createRecord(
        jsonRequest("POST", "records", {
          scheduleId,
          performedAt: "2026-09-15T10:00:00.000Z",
          odometerKm: 48_000,
          costCents: 8_999,
          vendorName: "Jiffy Lube",
          note: "Full synthetic",
          items: [{ category: "ENGINE_OIL", name: "0W-20", quantity: 4.5, unit: "QUARTS" }],
        }),
      );
      expect(created.status).toBe(201);
      const record = await json(created);
      expect(record.items).toHaveLength(1);
      expect(await prisma.expense.count({ where: { maintenanceRecordId: record.id } })).toBe(1);

      const patched = await patchRecord(
        jsonRequest("PATCH", `records/${record.id}`, { costCents: 9_499 }),
        params({ id: record.id }),
      );
      expect(patched.status).toBe(200);
      expect(await json(patched)).toMatchObject({
        costCents: 9_499,
        vendorName: "Jiffy Lube",
        note: "Full synthetic",
        odometerKm: 48_000,
        items: [expect.objectContaining({ name: "0W-20" })],
      });
    });
  });

  it("creates a manual vehicle that the creator owns", async () => {
    await as(stranger.id);
    const response = await createVehicle(
      jsonRequest("POST", "vehicles", {
        make: "Toyota",
        model: "Tacoma",
        productionYear: 2021,
        currentOdometerKm: 64_374,
      }),
    );
    expect(response.status).toBe(201);
    const vehicle = await json(response);
    expect(vehicle).toMatchObject({
      make: "Toyota",
      currentOdometerKm: 64_374,
      ownerUserId: stranger.id,
      access: { role: "OWNER", canEdit: true },
    });
  });

  it("merges note PATCHes and keeps notes private", async () => {
    await as(owner.id);
    const created = await createNote(
      jsonRequest("POST", "notes", { title: "Tire pressure", content: "36 psi", tags: ["tires"], vehicleId }),
    );
    expect(created.status).toBe(201);
    const note = await json(created);

    const patched = await patchNote(jsonRequest("PATCH", `notes/${note.id}`, { isPinned: true }), params({ id: note.id }));
    expect(await json(patched)).toMatchObject({ title: "Tire pressure", content: "36 psi", tags: ["tires"], isPinned: true });

    await as(editor.id);
    expect((await patchNote(jsonRequest("PATCH", `notes/${note.id}`, { title: "x" }), params({ id: note.id }))).status).toBe(404);
  });

  it("lets only a custom field's creator change it", async () => {
    const field = await prisma.vehicleCustomField.create({
      data: { userId: owner.id, label: "Tire size", fieldType: "TEXT" },
    });
    await as(editor.id);
    expect(
      (await patchCustomField(jsonRequest("PATCH", `custom-fields/${field.id}`, { label: "x" }), params({ id: field.id }))).status,
    ).toBe(403);
    await as(owner.id);
    const response = await patchCustomField(
      jsonRequest("PATCH", `custom-fields/${field.id}`, { unit: "in" }),
      params({ id: field.id }),
    );
    expect(await json(response)).toMatchObject({ label: "Tire size", unit: "in" });
  });

  describe("settings", () => {
    it("patches preferences strictly", async () => {
      await as(owner.id);
      const ok = await patchPreferences(
        jsonRequest("PATCH", "preferences", { distanceUnit: "mi", volumeUnit: "gal", timezone: "America/Chicago" }),
      );
      expect(await json(ok)).toMatchObject({ distanceUnit: "mi", volumeUnit: "gal", timezone: "America/Chicago" });
      expect((await patchPreferences(jsonRequest("PATCH", "preferences", { timezone: "Mars/Olympus" }))).status).toBe(422);
      expect((await patchPreferences(jsonRequest("PATCH", "preferences", { distanceUnit: "furlong" }))).status).toBe(422);
    });

    it("won't enable a push channel whose credentials were never set", async () => {
      await as(owner.id);
      const response = await patchNotifications(jsonRequest("PATCH", "notification-settings", { pushoverEnabled: true }));
      expect(response.status).toBe(422);
      expect((await json(response)).error.code).toBe("channel_not_configured");

      const ok = await patchNotifications(
        jsonRequest("PATCH", "notification-settings", { eventExpenseAdded: true, timezone: "America/Chicago" }),
      );
      expect(ok.status).toBe(200);
      expect(await json(ok)).toMatchObject({ eventExpenseAdded: true, pushoverConfigured: false });
    });
  });

  describe("OBD odometer readings (D-046)", () => {
    let obdVehicleId: string;
    const odo = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      createOdometer(jsonRequest("POST", "odometer", { vehicleId: obdVehicleId, ...body }, headers));

    beforeAll(async () => {
      obdVehicleId = (await createVehicleRow(owner.id, { make: "Skoda", model: "Octavia" })).id;
      await prisma.vehicle.update({ where: { id: obdVehicleId }, data: { currentOdometerKm: 80_000 } });
    });

    it("stores a higher OBD reading through the quick-update path", async () => {
      await as(owner.id);
      const response = await odo({ odometerKm: 80_500, source: "obd" });
      expect(response.status).toBe(201);
      expect(await json(response)).toMatchObject({ vehicleId: obdVehicleId, odometerKm: 80_500, source: "obd" });
      const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: obdVehicleId } });
      expect(vehicle.currentOdometerKm).toBe(80_500);
    });

    it("rejects an OBD reading that is not higher with 409 odometer_not_higher", async () => {
      await as(owner.id);
      for (const odometerKm of [80_500, 80_499, 10]) {
        const response = await odo({ odometerKm, source: "obd" });
        expect(response.status).toBe(409);
        expect((await json(response)).error.code).toBe("odometer_not_higher");
      }
      // Also when only the newest log is higher than the vehicle's reading.
      await prisma.vehicle.update({ where: { id: obdVehicleId }, data: { currentOdometerKm: 70_000 } });
      expect((await odo({ odometerKm: 75_000, source: "obd" })).status).toBe(409);
      await prisma.vehicle.update({ where: { id: obdVehicleId }, data: { currentOdometerKm: 80_500 } });
      expect(await prisma.odometerLog.count({ where: { vehicleId: obdVehicleId } })).toBe(1);
    });

    it("lets only one of two concurrent equal OBD readings through", async () => {
      await as(owner.id);
      const statuses = (await Promise.all([odo({ odometerKm: 81_000, source: "obd" }), odo({ odometerKm: 81_000, source: "obd" })]))
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([201, 409]);
    });

    it("still accepts a lower manual reading without pulling the odometer down", async () => {
      await as(owner.id);
      const response = await odo({ odometerKm: 60_000, recordedAt: "2025-01-01T00:00:00.000Z" });
      expect(response.status).toBe(201);
      expect(await json(response)).toMatchObject({ odometerKm: 60_000, source: "manual" });
      const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: obdVehicleId } });
      expect(vehicle.currentOdometerKm).toBe(81_000);
    });

    it("replays the original 201 for a retried OBD upload instead of a 409", async () => {
      await as(owner.id);
      const headers = { "idempotency-key": "outbox-obd-0001" };
      const first = await odo({ odometerKm: 82_000, source: "obd" }, headers);
      expect(first.status).toBe(201);
      const retry = await odo({ odometerKm: 82_000, source: "obd" }, headers);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect((await json(retry)).id).toBe((await json(first)).id);
      expect(await prisma.odometerLog.count({ where: { vehicleId: obdVehicleId, odometerKm: 82_000 } })).toBe(1);
    });

    it("rejects an unknown source with 422", async () => {
      await as(owner.id);
      const response = await odo({ odometerKm: 90_000, source: "wican" });
      expect(response.status).toBe(422);
      expect((await json(response)).error.issues.map((issue: Json) => issue.path)).toContain("source");
    });

    it("exposes source in the list and in /sync", async () => {
      await as(owner.id);
      const list = await json(await listOdometer(new Request(url(`odometer?vehicleId=${obdVehicleId}`))));
      const listed = list.items;
      expect(listed.map((row: Json) => row.source).sort()).toEqual(["manual", "obd", "obd", "obd"]);

      const synced: Json[] = [];
      let next = url("sync");
      for (;;) {
        const body = await json(await sync(new Request(next)));
        synced.push(...((body.changes.odometerLogs ?? []) as Json[]).filter((row) => row.vehicleId === obdVehicleId));
        if (!body.hasMore) break;
        next = url(`sync?cursor=${body.cursor}`);
      }
      expect(synced).toHaveLength(4);
      expect(synced.every((row: Json) => typeof row.source === "string")).toBe(true);
      expect(synced.some((row: Json) => row.source === "obd")).toBe(true);
    });
  });

  it("returns an expense created via the API in the read shape", async () => {
    await as(owner.id);
    const response = await createExpense(
      jsonRequest("POST", "expenses", {
        vehicleId,
        category: "REPAIR",
        occurredAt: "2026-10-02T12:00:00.000Z",
        amountCents: 25_000,
        description: "Windshield chip",
      }),
    );
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ amountCents: 25_000, category: "REPAIR" });
  });
});
