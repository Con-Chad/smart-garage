import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
import { POST as scanRoute } from "@/app/api/v1/records/receipt-scan/route";
import { POST as createRecord } from "@/app/api/v1/records/route";
import { POST as createExpense } from "@/app/api/v1/expenses/route";
import { GET as listDocuments } from "@/app/api/v1/documents/route";
import { createServiceReceiptScanHandler } from "@/lib/receipts/scan";
import type { ReceiptScannerConfig } from "@/lib/receipts/config";
import { ReceiptExtractionError } from "@/lib/receipts/extract";
import type { ModelServiceReceipt, ServiceReceiptExtractor } from "@/lib/receipts/service-extract";
import { workshopReceipt } from "@/test/fixtures/service-receipt";
import { createSchedule, createUser, createVehicle, shareVehicle } from "@/test/integration/factories";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tokens = new Map<string, string>();
async function as(userId: string) {
  if (!tokens.has(userId)) {
    tokens.set(userId, (await createApiDevice({ userId, name: "test" })).token);
  }
  request.headers = new Headers({ authorization: `Bearer ${tokens.get(userId)}` });
}

const url = (p: string) => `http://test/api/v1/${p}`;
const json = async (response: Response) => (await response.json()) as Json;

/** Only the leading bytes matter to the sniffer. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const PDF = Buffer.from("%PDF-1.4\n%fake receipt\n");

function upload(fields: Record<string, string>, file?: { bytes: Buffer; name: string; type: string }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) form.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return new Request(url("records/receipt-scan"), { method: "POST", body: form });
}

function jsonRequest(p: string, body: unknown) {
  return new Request(url(p), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeExtractor(
  answer: ModelServiceReceipt | Error = workshopReceipt,
): ServiceReceiptExtractor & { calls: number } {
  const extractor = {
    model: "fake-vision",
    calls: 0,
    async extract() {
      extractor.calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return extractor;
}

const enabled: ReceiptScannerConfig = {
  enabled: true,
  apiKey: "test-key-never-used",
  model: "fake-vision",
  dailyLimit: 30,
  effort: null,
};

const uploadDir = mkdtempSync(path.join(tmpdir(), "sg-service-scan-"));
const jpeg = { bytes: JPEG, name: "invoice.jpg", type: "image/jpeg" };

describe("POST /api/v1/records/receipt-scan", () => {
  let owner: { id: string };
  let viewer: { id: string };
  let stranger: { id: string };
  let vehicleId: string;
  let otherVehicleId: string;
  let oilScheduleId: string;
  let otherScheduleId: string;

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDir;
    [owner, viewer, stranger] = await Promise.all([createUser(), createUser(), createUser()]);
    vehicleId = (await createVehicle(owner.id, { make: "VW", model: "Passat" })).id;
    otherVehicleId = (await createVehicle(owner.id, { make: "VW", model: "Golf" })).id;
    await shareVehicle(vehicleId, viewer.id, "VIEWER");
    const template = await prisma.maintenanceTemplate.upsert({
      where: { slug: "oil_change" },
      update: {},
      create: { slug: "oil_change", category: "ENGINE", nameEn: "Engine oil & filter", nameDe: "Motoröl & Ölfilter" },
    });
    oilScheduleId = (
      await prisma.vehicleMaintenanceSchedule.create({
        data: { vehicleId, templateId: template.id, category: "ENGINE", intervalKm: 15000 },
      })
    ).id;
    await createSchedule(vehicleId, { customName: "Detailing" });
    otherScheduleId = (await createSchedule(otherVehicleId)).id;
  });

  afterAll(() => {
    delete process.env.UPLOAD_DIR;
    rmSync(uploadDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.RECEIPT_SCANNER_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it("is 404 while the feature is off and 401 without a device token", async () => {
    await as(owner.id);
    const off = await scanRoute(upload({ vehicleId }, jpeg));
    expect(off.status).toBe(404);
    expect((await json(off)).error.code).toBe("not_found");

    request.headers = new Headers();
    const handler = createServiceReceiptScanHandler({ extractor: fakeExtractor(), config: () => enabled });
    expect((await handler(upload({ vehicleId }, jpeg))).status).toBe(401);
  });

  it("saves the photo as a RECEIPT document and returns a record draft matched to the schedules", async () => {
    await as(owner.id);
    const extractor = fakeExtractor();
    const handler = createServiceReceiptScanHandler({ extractor, config: () => enabled });
    const response = await handler(upload({ vehicleId }, jpeg));
    expect(response.status).toBe(200);
    const body = await json(response);

    expect(extractor.calls).toBe(1);
    expect(body).toMatchObject({
      isServiceReceipt: true,
      warnings: [],
      model: "fake-vision",
      scansRemainingToday: 29,
    });
    expect(body.draft).toMatchObject({
      performedAtLocal: "2026-10-15T12:00:00",
      odometerKm: 48210,
      vendorName: "Autohaus Müller",
      expenseCategory: "MAINTENANCE",
      suggestedTarget: "record",
      suggestedScheduleId: oilScheduleId,
      totalCostCents: 23443,
      labourCents: 12000,
      partsCents: 7700,
      currency: "EUR",
    });
    expect(body.draft.serviceTypes.map((s: Json) => [s.templateSlug, s.scheduleId])).toEqual([
      ["oil_change", oilScheduleId],
      ["cabin_filter", null],
    ]);
    expect(body.draft.items).toHaveLength(2);

    const document = await prisma.document.findUniqueOrThrow({ where: { id: body.documentId } });
    expect(document).toMatchObject({ vehicleId, purpose: "RECEIPT", maintenanceRecordId: null, expenseId: null });
    expect(await prisma.maintenanceRecord.count({ where: { vehicleId } })).toBe(0);
    const scan = await prisma.receiptScan.findFirstOrThrow({ where: { documentId: body.documentId } });
    expect(scan).toMatchObject({ userId: owner.id, vehicleId, outcome: "ok", model: "fake-vision" });
  });

  it("answers isServiceReceipt false for fuel receipts and random photos, keeping the document", async () => {
    await as(owner.id);
    const fuel = createServiceReceiptScanHandler({
      extractor: fakeExtractor({ ...workshopReceipt, isFuelReceipt: true }),
      config: () => enabled,
    });
    const body = await json(await fuel(upload({ vehicleId }, { bytes: PNG, name: "pump.png", type: "image/png" })));
    expect(body).toMatchObject({ isServiceReceipt: false, draft: null, warnings: ["fuel_receipt"] });
    expect(await prisma.document.count({ where: { id: body.documentId, purpose: "RECEIPT" } })).toBe(1);
    const scan = await prisma.receiptScan.findFirstOrThrow({ where: { documentId: body.documentId } });
    expect(scan.outcome).toBe("not_service_receipt");
  });

  it("applies the same access, file and multipart checks as the fuel scan", async () => {
    const extractor = fakeExtractor();
    const handler = createServiceReceiptScanHandler({ extractor, config: () => enabled });

    await as(stranger.id);
    expect((await handler(upload({ vehicleId }, jpeg))).status).toBe(404);
    await as(viewer.id);
    expect((await handler(upload({ vehicleId }, jpeg))).status).toBe(403);

    await as(owner.id);
    const pdf = await handler(upload({ vehicleId }, { bytes: PDF, name: "r.pdf", type: "application/pdf" }));
    expect(pdf.status).toBe(415);
    expect((await handler(upload({ vehicleId }, { bytes: PNG, name: "r.jpg", type: "image/jpeg" }))).status).toBe(415);
    expect((await handler(upload({ vehicleId }))).status).toBe(422);
    expect((await handler(upload({}, jpeg))).status).toBe(422);
    const notMultipart = await handler(jsonRequest("records/receipt-scan", { vehicleId }));
    expect(notMultipart.status).toBe(415);
    expect(extractor.calls).toBe(0);
  });

  it("shares the daily limit with the fuel scan", async () => {
    const user = await createUser();
    const ownVehicle = (await createVehicle(user.id)).id;
    await as(user.id);
    await prisma.receiptScan.create({ data: { userId: user.id, vehicleId: ownVehicle, outcome: "ok" } });
    const limited = createServiceReceiptScanHandler({
      extractor: fakeExtractor(),
      config: () => ({ ...enabled, dailyLimit: 1 }),
    });
    const response = await limited(upload({ vehicleId: ownVehicle }, jpeg));
    expect(response.status).toBe(429);
    expect((await json(response)).error.code).toBe("rate_limited");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers 502 with the saved documentId when the provider fails", async () => {
    await as(owner.id);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createServiceReceiptScanHandler({
      extractor: fakeExtractor(new ReceiptExtractionError("timeout", "slow")),
      config: () => enabled,
    });
    const response = await handler(upload({ vehicleId }, jpeg));
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.error.code).toBe("extraction_failed");
    expect(typeof body.documentId).toBe("string");
    const scan = await prisma.receiptScan.findFirstOrThrow({ where: { documentId: body.documentId } });
    expect(scan.outcome).toBe("failed");
  });

  describe("linking the receipt", () => {
    async function scannedDocument(forVehicle: string) {
      const handler = createServiceReceiptScanHandler({ extractor: fakeExtractor(), config: () => enabled });
      return (await json(await handler(upload({ vehicleId: forVehicle }, jpeg)))).documentId as string;
    }

    const record = (overrides: Record<string, unknown> = {}) => ({
      scheduleId: oilScheduleId,
      performedAt: "2026-10-15T10:00:00.000Z",
      odometerKm: 48210,
      costCents: 23443,
      currency: "EUR",
      vendorName: "Autohaus Müller",
      items: [{ category: "ENGINE_OIL", name: "Motoröl 5W-30", quantity: 4.5, unit: "LITERS", costCents: 6210 }],
      ...overrides,
    });

    it("POST /records with receiptDocumentId attaches the document; a second link is 409", async () => {
      await as(owner.id);
      const documentId = await scannedDocument(vehicleId);
      const created = await createRecord(jsonRequest("records", record({ receiptDocumentId: documentId })));
      expect(created.status).toBe(201);
      const entry = await json(created);
      expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).maintenanceRecordId).toBe(entry.id);

      const listed = await json(await listDocuments(new Request(url(`documents?maintenanceRecordId=${entry.id}`))));
      expect(listed.items.map((d: Json) => d.id)).toEqual([documentId]);

      const again = await createRecord(jsonRequest("records", record({ receiptDocumentId: documentId })));
      expect(again.status).toBe(409);
      expect((await json(again)).error.code).toBe("document_already_linked");
    });

    it("POST /records refuses another vehicle's document as 404 without creating the record", async () => {
      await as(owner.id);
      const otherDocument = await scannedDocument(otherVehicleId);
      const before = await prisma.maintenanceRecord.count();
      const wrong = await createRecord(jsonRequest("records", record({ receiptDocumentId: otherDocument })));
      expect(wrong.status).toBe(404);
      const unknown = await createRecord(
        jsonRequest("records", record({ scheduleId: otherScheduleId, receiptDocumentId: "nope" })),
      );
      expect(unknown.status).toBe(404);
      expect(await prisma.maintenanceRecord.count()).toBe(before);
    });

    it("POST /expenses with receiptDocumentId attaches the document", async () => {
      await as(owner.id);
      const documentId = await scannedDocument(vehicleId);
      const expense = {
        vehicleId,
        category: "INSURANCE",
        occurredAt: "2026-10-15T10:00:00.000Z",
        amountCents: 45000,
        currency: "EUR",
        receiptDocumentId: documentId,
      };
      const created = await createExpense(jsonRequest("expenses", expense));
      expect(created.status).toBe(201);
      const entry = await json(created);
      expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).expenseId).toBe(entry.id);

      const again = await createExpense(jsonRequest("expenses", expense));
      expect(again.status).toBe(409);

      const other = await scannedDocument(otherVehicleId);
      const wrong = await createExpense(jsonRequest("expenses", { ...expense, receiptDocumentId: other }));
      expect(wrong.status).toBe(404);
    });
  });
});
