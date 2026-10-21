import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { prisma } from "@/lib/prisma";
import { createApiDevice } from "@/lib/repositories/api-devices";
import { RESOURCE_KEYS } from "@/lib/api/v1/resources";
import { listResource, getResource } from "@/lib/api/v1/collection";
import { GET as sync } from "@/app/api/v1/sync/route";
import { GET as documentContent } from "@/app/api/v1/documents/[id]/content/route";
import { GET as notificationSettings } from "@/app/api/v1/notification-settings/route";
import { GET as reminders } from "@/app/api/v1/reminders/route";
import { GET as expenseSummary } from "@/app/api/v1/expenses/summary/route";
import { GET as vehicleShares } from "@/app/api/v1/vehicles/[id]/shares/route";
import { saveVehicleDocument } from "@/lib/storage/local";
import {
  createSchedule,
  createUser,
  createVehicle,
  shareVehicle,
} from "@/test/integration/factories";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tokens = new Map<string, string>();
async function tokenFor(userId: string) {
  if (!tokens.has(userId)) {
    tokens.set(userId, (await createApiDevice({ userId, name: "test" })).token);
  }
  return tokens.get(userId)!;
}

async function as(userId: string) {
  request.headers = new Headers({ authorization: `Bearer ${await tokenFor(userId)}` });
}

const url = (p: string) => `http://test/api/v1/${p}`;

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

async function syncAll(query: string): Promise<{ pages: Json[]; merged: Json }> {
  const pages: Json[] = [];
  let next = url(`sync?${query}`);
  for (;;) {
    const response = await sync(new Request(next));
    expect(response.status).toBe(200);
    const body = await json(response);
    pages.push(body);
    if (!body.hasMore) break;
    const limit = new URL(next).searchParams.get("limit");
    next = url(`sync?cursor=${body.cursor}${limit ? `&limit=${limit}` : ""}`);
  }
  const merged: Json = { changes: {}, deletions: pages.at(-1)!.deletions };
  for (const body of pages) {
    for (const [key, rows] of Object.entries(body.changes as Record<string, Json[]>)) {
      merged.changes[key] = [...(merged.changes[key] ?? []), ...rows];
    }
  }
  return { pages, merged };
}

const ids = (rows: Json[] | undefined) => (rows ?? []).map((row) => row.id).sort();

let fuelDay = 0;
async function addFuel(vehicleId: string, userId: string) {
  fuelDay += 1;
  return prisma.fuelEntry.create({
    data: {
      vehicleId,
      filledAt: new Date(Date.UTC(2026, 0, fuelDay)),
      liters: 40,
      odometerKm: 1000 * fuelDay,
      totalCostCents: BigInt(5000 + fuelDay),
      currency: "USD",
      createdByUserId: userId,
    },
  });
}

const uploadDir = mkdtempSync(path.join(tmpdir(), "sg-read-api-"));

describe("API v1 read endpoints", () => {
  let owner: { id: string };
  let viewer: { id: string };
  let stranger: { id: string };
  let vehicleId: string;
  let strangerVehicleId: string;
  let ownerFuelId: string;
  let documentId: string;

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDir;
    [owner, viewer, stranger] = await Promise.all([createUser(), createUser(), createUser()]);
    vehicleId = (await createVehicle(owner.id, { make: "Mazda", model: "CX-5" })).id;
    strangerVehicleId = (await createVehicle(stranger.id, { make: "Volvo" })).id;
    await shareVehicle(vehicleId, viewer.id, "VIEWER");

    ownerFuelId = (await addFuel(vehicleId, owner.id)).id;
    await addFuel(strangerVehicleId, stranger.id);
    await createSchedule(vehicleId);
    await prisma.note.create({ data: { ownerUserId: owner.id, title: "Private", content: "", vehicleId } });
    await prisma.wishlistItem.create({ data: { userId: owner.id, title: "Roof box" } });
    await prisma.expense.create({
      data: {
        vehicleId,
        category: "REPAIR",
        occurredAt: new Date("2026-03-15T12:00:00Z"),
        amountCents: BigInt(25000),
        currency: "USD",
        createdByUserId: owner.id,
      },
    });
    await prisma.userNotificationSettings.create({
      data: { userId: owner.id, pushoverEnabled: true, pushoverUserKey: "u-secret", pushoverAppToken: "a-secret" },
    });

    const saved = await saveVehicleDocument(
      vehicleId,
      new File([Buffer.from("%PDF-1.4 receipt")], "receipt.pdf", { type: "application/pdf" }),
    );
    documentId = (
      await prisma.document.create({
        data: {
          vehicleId,
          uploadedByUserId: owner.id,
          purpose: "RECEIPT",
          originalFilename: saved.originalFilename,
          storageKey: saved.storageKey,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
        },
      })
    ).id;
  });

  afterAll(() => {
    delete process.env.UPLOAD_DIR;
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it("requires authentication", async () => {
    request.headers = new Headers();
    expect((await listResource(new Request(url("fuel")), "fuelEntries")).status).toBe(401);
    expect((await sync(new Request(url("sync")))).status).toBe(401);
  });

  it("never shows another user's rows in any collection", async () => {
    await as(stranger.id);
    const ownerRowIds = new Set<string>([vehicleId, ownerFuelId, documentId]);
    for (const key of RESOURCE_KEYS) {
      const body = await json(await listResource(new Request(url(`x?limit=200`)), key));
      for (const item of body.items as Json[]) {
        expect(ownerRowIds.has(item.id), `${key} leaked ${item.id}`).toBe(false);
        if ("vehicleId" in item && item.vehicleId) expect(item.vehicleId).not.toBe(vehicleId);
        if ("userId" in item) expect([stranger.id]).toContain(item.userId);
        if ("ownerUserId" in item) expect(item.ownerUserId).toBe(stranger.id);
      }
    }
    expect((await getResource("vehicles", vehicleId)).status).toBe(404);
    expect((await getResource("fuelEntries", ownerFuelId)).status).toBe(404);
    expect((await getResource("documents", documentId)).status).toBe(404);

    const { merged } = await syncAll("");
    expect(ids(merged.changes.vehicles)).toEqual([strangerVehicleId]);
    expect(ids(merged.changes.fuelEntries)).not.toContain(ownerFuelId);
  });

  it("lets a viewer read a shared vehicle and its data, but not the owner's private rows", async () => {
    await as(viewer.id);
    const vehicle = await json(await getResource("vehicles", vehicleId));
    expect(vehicle).toMatchObject({
      make: "Mazda",
      access: { role: "VIEWER", canEdit: false },
      owner: { id: owner.id },
    });
    const fuel = await json(await getResource("fuelEntries", ownerFuelId));
    expect(fuel).toMatchObject({ liters: 40, totalCostCents: 5000 + 1, currency: "USD" });

    expect((await json(await listResource(new Request(url("notes")), "notes"))).items).toEqual([]);
    expect((await json(await listResource(new Request(url("wishlist")), "wishlistItems"))).items).toEqual([]);
  });

  it("reports the owner's access", async () => {
    await as(owner.id);
    expect((await json(await getResource("vehicles", vehicleId))).access).toEqual({
      role: "OWNER",
      canEdit: true,
    });
  });

  it("paginates lists with stable keyset cursors", async () => {
    const paged = (await createVehicle(owner.id, { make: "Paged" })).id;
    for (let i = 0; i < 7; i++) await addFuel(paged, owner.id);
    await as(owner.id);

    const seen: string[] = [];
    const dates: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `fuel?vehicleId=${paged}&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const body = await json(await listResource(new Request(url(query)), "fuelEntries"));
      seen.push(...body.items.map((item: Json) => item.id));
      dates.push(...body.items.map((item: Json) => item.filledAt));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect([...dates].sort().reverse()).toEqual(dates);

    const bad = await listResource(new Request(url("fuel?cursor=not-a-cursor")), "fuelEntries");
    expect(bad.status).toBe(400);
  });

  it("does a full sync first, then returns only what changed or was deleted", async () => {
    await as(owner.id);
    const full = await syncAll("");
    expect(full.pages[0].fullResync).toBe(true);
    expect(full.pages[0].preferences).toHaveProperty("distanceUnit");
    expect(ids(full.merged.changes.vehicles)).toContain(vehicleId);
    expect(full.merged.changes.maintenanceTemplates).toBeUndefined(); // none seeded in tests
    const since = full.pages.at(-1)!.nextSince as string;
    expect(since).toBeTruthy();

    // Back-date the whole data set so the 5 s overlap window doesn't re-send it.
    const past = new Date(Date.now() - 60_000);
    const older = past.getTime() - 60_000;
    for (const table of ["Vehicle", "FuelEntry", "Expense", "Note", "WishlistItem", "VehicleMaintenanceSchedule", "Document"]) {
      await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "updatedAt" = ?`, older);
    }
    const nothing = await syncAll(`since=${encodeURIComponent(past.toISOString())}`);
    expect(nothing.pages[0].fullResync).toBe(false);
    expect(nothing.merged.changes).toEqual({});

    const doomed = await addFuel(vehicleId, owner.id);
    await prisma.fuelEntry.update({ where: { id: ownerFuelId }, data: { note: "edited" } });
    await prisma.fuelEntry.delete({ where: { id: doomed.id } });
    await prisma.vehicleMaintenanceSchedule.updateMany({ where: { vehicleId }, data: { isActive: false } });

    const delta = await syncAll(`since=${encodeURIComponent(past.toISOString())}`);
    expect(Object.keys(delta.merged.changes)).toEqual(["fuelEntries"]);
    expect(ids(delta.merged.changes.fuelEntries)).toEqual([ownerFuelId]);
    expect(delta.merged.changes.fuelEntries[0].note).toBe("edited");
    expect(delta.merged.deletions.fuelEntries).toEqual([doomed.id]);
    expect(delta.merged.deletions.schedules).toHaveLength(1);
  });

  it("returns the same data in small pages as in one page", async () => {
    await as(owner.id);
    const whole = await syncAll("limit=1000");
    const small = await syncAll("limit=2");
    expect(small.pages.length).toBeGreaterThan(2);
    for (const key of Object.keys(whole.merged.changes)) {
      expect(ids(small.merged.changes[key]), key).toEqual(ids(whole.merged.changes[key]));
    }
  });

  it("sends a newly shared vehicle with its existing history", async () => {
    const friend = await createUser();
    await as(friend.id);
    const first = await syncAll("");
    const since = first.pages.at(-1)!.nextSince as string;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await shareVehicle(vehicleId, friend.id, "EDITOR");
    const delta = await syncAll(`since=${encodeURIComponent(since)}`);
    expect(ids(delta.merged.changes.vehicles)).toEqual([vehicleId]);
    expect(delta.merged.changes.vehicles[0].access).toEqual({ role: "EDITOR", canEdit: true });
    expect(ids(delta.merged.changes.fuelEntries)).toContain(ownerFuelId);
    expect(ids(delta.merged.changes.documents)).toContain(documentId);
  });

  it("tells a user who lost access to drop the vehicle, without touching the owner", async () => {
    const friend = await createUser();
    const share = await shareVehicle(vehicleId, friend.id, "VIEWER");
    const since = new Date(Date.now() - 1000).toISOString();
    await prisma.vehicleShare.delete({ where: { id: share.id } });

    await as(friend.id);
    expect((await syncAll(`since=${since}`)).merged.deletions.vehicles).toEqual([vehicleId]);
    await as(owner.id);
    expect((await syncAll(`since=${since}`)).merged.deletions.vehicles ?? []).not.toContain(vehicleId);
  });

  it("forces a full resync after a backup import or when too far behind", async () => {
    await as(viewer.id);
    const since = new Date(Date.now() - 1000).toISOString();
    expect((await syncAll(`since=${since}`)).pages[0].fullResync).toBe(false);

    // The owner restores a backup: everyone the owner shares with resyncs too.
    await prisma.syncTombstone.create({ data: { entity: "*", entityId: owner.id, userId: owner.id } });
    expect((await syncAll(`since=${since}`)).pages[0].fullResync).toBe(true);

    const ancient = new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString();
    await as(stranger.id);
    expect((await syncAll(`since=${ancient}`)).pages[0].fullResync).toBe(true);
    expect((await sync(new Request(url("sync?since=yesterday")))).status).toBe(400);
    expect((await sync(new Request(url("sync?cursor=garbage")))).status).toBe(400);
  });

  it("serves document metadata without storage details and the bytes to anyone with access", async () => {
    await as(viewer.id);
    const meta = await json(await getResource("documents", documentId));
    expect(meta).toMatchObject({ mimeType: "application/pdf", originalFilename: "receipt.pdf" });
    expect(meta).not.toHaveProperty("storageKey");

    const params = { params: Promise.resolve({ id: documentId }) };
    const content = await documentContent(new Request(url("x")), params);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await content.arrayBuffer()).toString()).toBe("%PDF-1.4 receipt");

    await as(stranger.id);
    const denied = await documentContent(new Request(url("x")), { params: Promise.resolve({ id: documentId }) });
    expect(denied.status).toBe(404);
  });

  it("never returns notification credentials", async () => {
    await as(owner.id);
    const body = await json(await notificationSettings());
    expect(body).toMatchObject({ pushoverEnabled: true, pushoverConfigured: true, telegramConfigured: false });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("computes reminders and expense summaries for the caller", async () => {
    await as(owner.id);
    const reminderBody = await json(await reminders());
    expect(reminderBody).toHaveProperty("due");
    expect(reminderBody).toHaveProperty("inspections");

    const summary = await json(await expenseSummary(new Request(url("expenses/summary?groupBy=month"))));
    expect(summary.groups).toContainEqual({ key: "2026-03", currency: "USD", totalCents: 25000, count: 1 });
    const byCategory = await json(await expenseSummary(new Request(url("expenses/summary?groupBy=category"))));
    expect(byCategory.groups[0]).toMatchObject({ key: "REPAIR", totalCents: 25000 });
    expect((await expenseSummary(new Request(url("expenses/summary?groupBy=year")))).status).toBe(400);

    await as(stranger.id);
    const strangers = await json(await expenseSummary(new Request(url("expenses/summary"))));
    expect(strangers.groups).toEqual([]);
  });

  it("shows a vehicle's shares to the owner only", async () => {
    const params = () => ({ params: Promise.resolve({ id: vehicleId }) });
    await as(owner.id);
    const body = await json(await vehicleShares(new Request(url("x")), params()));
    expect(body.items.map((share: Json) => share.user.id)).toContain(viewer.id);
    await as(viewer.id);
    expect((await vehicleShares(new Request(url("x")), params())).status).toBe(403);
    await as(stranger.id);
    expect((await vehicleShares(new Request(url("x")), params())).status).toBe(404);
  });
});
