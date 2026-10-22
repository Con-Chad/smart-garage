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
import { POST as scanRoute } from "@/app/api/v1/fuel/receipt-scan/route";
import { POST as createFuel } from "@/app/api/v1/fuel/route";
import { GET as listDocuments } from "@/app/api/v1/documents/route";
import { GET as me } from "@/app/api/v1/me/route";
import { createReceiptScanHandler } from "@/lib/receipts/scan";
import type { ReceiptScannerConfig } from "@/lib/receipts/config";
import { ReceiptExtractionError, type ModelReceipt, type ReceiptExtractor } from "@/lib/receipts/extract";
import { createUser, createVehicle, shareVehicle } from "@/test/integration/factories";

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
  return new Request(url("fuel/receipt-scan"), { method: "POST", body: form });
}

function jsonRequest(p: string, body: unknown) {
  return new Request(url(p), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const receipt: ModelReceipt = {
  isFuelReceipt: true,
  stationName: "Shell",
  stationAddress: "123 Main St, Springfield",
  purchasedAt: "2026-10-20T14:32:00",
  volume: { value: 11.482, unit: "gal" },
  pricePerUnit: { value: 3.459, currency: "USD" },
  total: { value: 39.72, currency: "USD" },
  fuelGrade: "Regular 87",
  confidence: { volume: 0.98, total: 0.99, purchasedAt: 0.9, pricePerUnit: 0.95, stationName: 0.9 },
};

function fakeExtractor(answer: ModelReceipt | Error = receipt): ReceiptExtractor & { calls: number } {
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

const uploadDir = mkdtempSync(path.join(tmpdir(), "sg-receipt-scan-"));

describe("POST /api/v1/fuel/receipt-scan", () => {
  let owner: { id: string };
  let editor: { id: string };
  let viewer: { id: string };
  let stranger: { id: string };
  let vehicleId: string;
  let otherVehicleId: string;

  beforeAll(async () => {
    process.env.UPLOAD_DIR = uploadDir;
    [owner, editor, viewer, stranger] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    vehicleId = (await createVehicle(owner.id, { make: "Mazda", model: "CX-5" })).id;
    otherVehicleId = (await createVehicle(owner.id, { make: "VW", model: "Golf" })).id;
    await shareVehicle(vehicleId, editor.id, "EDITOR");
    await shareVehicle(vehicleId, viewer.id, "VIEWER");
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

  it("is 404 while the feature is off, and so is the flag without a key", async () => {
    await as(owner.id);
    const off = await scanRoute(upload({ vehicleId }, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" }));
    expect(off.status).toBe(404);
    expect((await json(off)).error.code).toBe("not_found");

    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.RECEIPT_SCANNER_ENABLED = "true";
    const noKey = await scanRoute(upload({ vehicleId }, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" }));
    expect(noKey.status).toBe(404);

    const handler = createReceiptScanHandler({ extractor: fakeExtractor(), config: () => ({ ...enabled, enabled: false }) });
    expect((await handler(upload({ vehicleId }, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" }))).status).toBe(404);
  });

  it("needs a device token", async () => {
    request.headers = new Headers();
    const handler = createReceiptScanHandler({ extractor: fakeExtractor(), config: () => enabled });
    expect((await handler(upload({ vehicleId }, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" }))).status).toBe(401);
  });

  it("saves the photo as a RECEIPT document and returns a draft in stored units", async () => {
    await as(editor.id);
    const extractor = fakeExtractor();
    const handler = createReceiptScanHandler({ extractor, config: () => enabled });
    const response = await handler(upload({ vehicleId }, { bytes: JPEG, name: "pump.jpg", type: "image/jpeg" }));
    expect(response.status).toBe(200);
    const body = await json(response);

    expect(extractor.calls).toBe(1);
    expect(body.isFuelReceipt).toBe(true);
    expect(body.model).toBe("fake-vision");
    expect(body.scansRemainingToday).toBe(29);
    expect(body.warnings).toEqual([]);
    expect(body.draft).toMatchObject({
      filledAtLocal: "2026-10-20T14:32:00",
      liters: 43.464,
      totalCostCents: 3972,
      currency: "USD",
      stationName: "Shell",
      fuelGrade: "Regular 87",
      confidence: { filledAtLocal: 0.9, liters: 0.98, totalCostCents: 0.99, stationName: 0.9 },
    });

    const document = await prisma.document.findUniqueOrThrow({ where: { id: body.documentId } });
    expect(document).toMatchObject({
      vehicleId,
      uploadedByUserId: editor.id,
      purpose: "RECEIPT",
      mimeType: "image/jpeg",
      originalFilename: "pump.jpg",
      fuelEntryId: null,
    });
    expect(await prisma.fuelEntry.count({ where: { vehicleId } })).toBe(0);

    const scan = await prisma.receiptScan.findFirstOrThrow({ where: { documentId: body.documentId } });
    expect(scan).toMatchObject({ userId: editor.id, vehicleId, outcome: "ok", model: "fake-vision" });
  });

  it("tells the app when the photo isn't a fuel receipt but keeps the document", async () => {
    await as(owner.id);
    const handler = createReceiptScanHandler({
      extractor: fakeExtractor({ ...receipt, isFuelReceipt: false }),
      config: () => enabled,
    });
    const body = await json(await handler(upload({ vehicleId }, { bytes: PNG, name: "cat.png", type: "image/png" })));
    expect(body).toMatchObject({ isFuelReceipt: false, draft: null, warnings: ["not_fuel_receipt"] });
    expect(await prisma.document.count({ where: { id: body.documentId, purpose: "RECEIPT" } })).toBe(1);
    const scan = await prisma.receiptScan.findFirstOrThrow({ where: { documentId: body.documentId } });
    expect(scan.outcome).toBe("not_fuel_receipt");
  });

  it("hides vehicles the user can't see (404) and refuses viewers (403)", async () => {
    const handler = createReceiptScanHandler({ extractor: fakeExtractor(), config: () => enabled });
    const file = { bytes: JPEG, name: "r.jpg", type: "image/jpeg" };

    await as(stranger.id);
    expect((await handler(upload({ vehicleId }, file))).status).toBe(404);

    await as(owner.id);
    expect((await handler(upload({ vehicleId: "does-not-exist" }, file))).status).toBe(404);

    await as(viewer.id);
    const forbidden = await handler(upload({ vehicleId }, file));
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).error.code).toBe("forbidden");

    expect(await prisma.receiptScan.count({ where: { userId: { in: [stranger.id, viewer.id] } } })).toBe(0);
  });

  it("rejects non-images, mismatched content and missing parts before saving anything", async () => {
    await as(owner.id);
    const extractor = fakeExtractor();
    const handler = createReceiptScanHandler({ extractor, config: () => enabled });
    const before = await prisma.document.count({ where: { vehicleId } });

    const pdf = await handler(upload({ vehicleId }, { bytes: PDF, name: "r.pdf", type: "application/pdf" }));
    expect(pdf.status).toBe(415);
    expect((await json(pdf)).error.code).toBe("unsupported_file_type");

    const mislabeled = await handler(upload({ vehicleId }, { bytes: PNG, name: "r.jpg", type: "image/jpeg" }));
    expect(mislabeled.status).toBe(415);

    const text = await handler(upload({ vehicleId }, { bytes: Buffer.from("hello"), name: "r.txt", type: "text/plain" }));
    expect(text.status).toBe(415);

    const noFile = await handler(upload({ vehicleId }));
    expect(noFile.status).toBe(422);

    const noVehicle = await handler(upload({}, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" }));
    expect(noVehicle.status).toBe(422);

    const notMultipart = await handler(jsonRequest("fuel/receipt-scan", { vehicleId }));
    expect(notMultipart.status).toBe(415);
    expect((await json(notMultipart)).error.code).toBe("multipart_required");

    expect(extractor.calls).toBe(0);
    expect(await prisma.document.count({ where: { vehicleId } })).toBe(before);
  });

  it("enforces the per-user daily limit with a Retry-After", async () => {
    const limited = createReceiptScanHandler({
      extractor: fakeExtractor(),
      config: () => ({ ...enabled, dailyLimit: 1 }),
      now: () => new Date("2026-10-22T23:59:00Z"),
    });
    await as(stranger.id);
    const ownVehicle = (await createVehicle(stranger.id)).id;
    const file = { bytes: JPEG, name: "r.jpg", type: "image/jpeg" };

    const first = await limited(upload({ vehicleId: ownVehicle }, file));
    expect(first.status).toBe(200);
    expect((await json(first)).scansRemainingToday).toBe(0);

    const second = await limited(upload({ vehicleId: ownVehicle }, file));
    expect(second.status).toBe(429);
    expect((await json(second)).error.code).toBe("rate_limited");
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(second.headers.get("retry-after"))).toBeLessThanOrEqual(60);

    // The limit is per user: someone who hasn't scanned today is unaffected.
    const fresh = await createUser();
    const freshVehicle = (await createVehicle(fresh.id)).id;
    await as(fresh.id);
    expect((await limited(upload({ vehicleId: freshVehicle }, file))).status).toBe(200);
  });

  it("never admits more concurrent scans than the limit, and frees rejected slots (S-5)", async () => {
    const racer = await createUser();
    const racerVehicle = (await createVehicle(racer.id)).id;
    await as(racer.id);
    const extractor = fakeExtractor();
    const limited = createReceiptScanHandler({ extractor, config: () => ({ ...enabled, dailyLimit: 3 }) });
    const file = { bytes: JPEG, name: "r.jpg", type: "image/jpeg" };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => limited(upload({ vehicleId: racerVehicle }, file))),
    );
    const statuses = responses.map((r) => r.status);
    const admitted = statuses.filter((s) => s === 200).length;
    expect(admitted).toBeGreaterThanOrEqual(1);
    expect(admitted).toBeLessThanOrEqual(3);
    expect(statuses.filter((s) => s === 429).length).toBe(10 - admitted);
    expect(extractor.calls).toBe(admitted);

    // Over-limit attempts leave no rows and no documents behind.
    expect(await prisma.receiptScan.count({ where: { userId: racer.id } })).toBe(admitted);
    expect(await prisma.receiptScan.count({ where: { userId: racer.id, outcome: "pending" } })).toBe(0);
    expect(await prisma.document.count({ where: { vehicleId: racerVehicle } })).toBe(admitted);
  });

  it("answers 502 with the saved documentId when the provider fails, and never leaks its error", async () => {
    await as(owner.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createReceiptScanHandler({
      extractor: fakeExtractor(new ReceiptExtractionError("provider", "The vision provider rejected the request", 529)),
      config: () => enabled,
    });
    const response = await handler(upload({ vehicleId }, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" }));
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.error.code).toBe("extraction_failed");
    expect(typeof body.documentId).toBe("string");
    expect(JSON.stringify(body)).not.toContain("529");
    expect(warn).toHaveBeenCalled();

    const scan = await prisma.receiptScan.findFirstOrThrow({ where: { documentId: body.documentId } });
    expect(scan.outcome).toBe("failed");
    expect(await prisma.document.count({ where: { id: body.documentId } })).toBe(1);
  });

  describe("linking the receipt to the fill-up", () => {
    async function scannedDocument(forVehicle: string) {
      const handler = createReceiptScanHandler({ extractor: fakeExtractor(), config: () => enabled });
      const body = await json(await handler(upload({ vehicleId: forVehicle }, { bytes: JPEG, name: "r.jpg", type: "image/jpeg" })));
      return body.documentId as string;
    }

    const fillUp = (overrides: Record<string, unknown> = {}) => ({
      vehicleId,
      filledAt: "2026-10-20T19:32:00.000Z",
      odometerKm: 50_000,
      liters: 43.464,
      totalCostCents: 3972,
      currency: "USD",
      stationName: "Shell",
      ...overrides,
    });

    it("POST /fuel with receiptDocumentId attaches the document to the new entry", async () => {
      await as(owner.id);
      const documentId = await scannedDocument(vehicleId);

      const created = await createFuel(jsonRequest("fuel", fillUp({ receiptDocumentId: documentId })));
      expect(created.status).toBe(201);
      const entry = await json(created);

      const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(document.fuelEntryId).toBe(entry.id);

      const listed = await json(await listDocuments(new Request(url(`documents?fuelEntryId=${entry.id}`))));
      expect(listed.items.map((d: Json) => d.id)).toEqual([documentId]);
      expect(listed.items[0].fuelEntryId).toBe(entry.id);

      const again = await createFuel(jsonRequest("fuel", fillUp({ receiptDocumentId: documentId })));
      expect(again.status).toBe(409);
      expect((await json(again)).error.code).toBe("document_already_linked");
    });

    it("refuses documents of other vehicles and unknown ids as 404, without creating the entry", async () => {
      await as(owner.id);
      const otherDocument = await scannedDocument(otherVehicleId);
      const entries = await prisma.fuelEntry.count({ where: { vehicleId } });

      const wrongVehicle = await createFuel(jsonRequest("fuel", fillUp({ receiptDocumentId: otherDocument })));
      expect(wrongVehicle.status).toBe(404);
      const unknown = await createFuel(jsonRequest("fuel", fillUp({ receiptDocumentId: "nope" })));
      expect(unknown.status).toBe(404);

      expect(await prisma.fuelEntry.count({ where: { vehicleId } })).toBe(entries);
      expect((await prisma.document.findUniqueOrThrow({ where: { id: otherDocument } })).fuelEntryId).toBeNull();
    });

    it("still accepts a fill-up without a receipt", async () => {
      await as(owner.id);
      expect((await createFuel(jsonRequest("fuel", fillUp()))).status).toBe(201);
    });
  });

  it("GET /me advertises the feature only when it is on", async () => {
    await as(owner.id);
    expect((await json(await me())).features).toEqual({ receiptScanner: false });

    process.env.RECEIPT_SCANNER_ENABLED = "true";
    process.env.ANTHROPIC_API_KEY = "test-key-never-used";
    expect((await json(await me())).features).toEqual({ receiptScanner: true });
  });
});
