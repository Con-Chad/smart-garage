# Receipt scanner: outline (post-v1)

Status: **planned, not implemented.** This is the design to pick up after v1 ships.
Decision record: D-012 in `DECISIONS.md`.

## Goal

At the pump: tap **Scan receipt**, take a photo, and about two seconds later
the quick fill-up screen opens with every field filled in. You check the
odometer and tap **Save**. The receipt photo is attached to the fill-up.

The scan never saves on its own. One misread digit (6.5 read as 8.5 gal)
quietly ruins MPG history, so the confirm screen stays, at the cost of one tap.

## Flow

1. **App:** a CameraX capture. It is downscaled to about 1600px on the long
   edge and saved as JPEG at ~80% quality, which keeps it well under the 10 MB
   image limit and the model's image limits.
2. **App:** `POST /api/v1/fuel/receipt-scan` (multipart: `file`, `vehicleId`).
3. **Server:**
   1. Check that the user can edit the vehicle.
   2. Save the image as a `Document` with `purpose=RECEIPT`.
   3. Send the image to the vision model with a strict JSON schema
      (structured output).
   4. Validate the result with zod.
   5. Convert to stored units.
   6. Return a **draft**. Nothing is written to `FuelEntry` yet.
4. **App:** the quick fill-up screen opens prefilled from the draft.
   Low-confidence fields are highlighted. The odometer is prefilled from the
   last reading plus the average distance per day since then, for you to
   confirm.
5. **App:** `POST /api/v1/fuel` with the fields plus `receiptDocumentId`. The
   server links the document to the new entry.

**Offline:** the photo and an "unscanned" outbox item are queued. When signal
comes back, the scan runs and the user gets a notification to review and save
the draft.

## Extraction schema (model output)

```json
{
  "isFuelReceipt": true,
  "stationName": "Shell",
  "stationAddress": "123 Main St, Springfield",
  "purchasedAt": "2026-10-20T14:32:00",
  "volume": { "value": 11.482, "unit": "gal" },
  "pricePerUnit": { "value": 3.459, "currency": "USD" },
  "total": { "value": 39.72, "currency": "USD" },
  "fuelGrade": "Regular 87",
  "confidence": { "volume": 0.98, "total": 0.99, "purchasedAt": 0.9 }
}
```

**Server-side checks:**
- `volume × pricePerUnit ≈ total` (±2%). If this fails, confidence is lowered
  and the fields are highlighted.
- `isFuelReceipt=false` produces a "This doesn't look like a fuel receipt"
  message, with the option to attach the photo anyway.
- Gallons are converted to liters and dollars to cents before anything is
  stored (`lib/regional/volume.ts`).

## Server changes (all additive)

- **Migration:** add `Document.fuelEntryId String?`
  (`onDelete: SetNull`, `@@index`), so receipts can link to fill-ups. Today a
  document can only link to a vehicle, a maintenance record or an expense.
- **`lib/receipts/extract.ts`:** an `ReceiptExtractor` interface with a
  `claudeVisionExtractor` implementation. The interface lets an on-device or
  local-OCR extractor slot in later.
- **Env:**
  - `RECEIPT_SCANNER_ENABLED=false` (off by default, so upstream stays the same)
  - `ANTHROPIC_API_KEY`
  - `RECEIPT_SCANNER_MODEL`: pick a current vision-capable model at
    implementation time and check it against the Claude API docs.
- **Endpoint:**
  - `POST /api/v1/fuel/receipt-scan`, rate-limited per user (e.g. 30 per day).
  - `/api/v1/me` gains `features.receiptScanner` so the app hides the button
    when the feature is off.
- **Web UI (optional):** the same scan on the existing quick fill-up form.

## Cost and billing

**API usage is billed separately from a Claude Max subscription,** through the
Anthropic Console with its own API key. Check current pricing there before
enabling it. A single receipt image plus a short JSON answer is a small
request, typically well under a cent with a small vision model. The API key
lives only on the server and never in the app.

## Privacy

Receipt images are sent to Anthropic for extraction. Receipts carry the
station, the time, and sometimes the last four digits of a card. The operator
turns this on deliberately (`RECEIPT_SCANNER_ENABLED`).

## Tests

- **Unit:** schema validation, unit conversion, and the
  volume × price ≈ total check, run against fixture JSON. No network calls.
- **Integration:** the scan route with the extractor mocked. Covers access
  rules (viewer gets 403), document creation, and the draft shape.
- **Manual acceptance:** 10 real receipts from different chains, including
  crumpled and faded thermal paper. Target ≥ 9/10 with volume and total correct.

## Estimate

About one checkpoint of work: the migration, the extractor and endpoint, the
app screen, and the offline queue path.
