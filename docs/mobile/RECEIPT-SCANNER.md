# Receipt scanner: server contract

Status: **server side implemented** (D-012 planned it, D-042 records the
implementation). The Android screen and offline queue code against this file.
Everything below is what the server does today; the "Flow" section describes
the app side as agreed.

## Goal

At the pump: tap **Scan receipt**, take a photo, and about two seconds later
the quick fill-up screen opens with every field filled in. You check the
odometer and tap **Save**. The receipt photo is attached to the fill-up.

The scan never saves on its own. One misread digit (6.5 read as 8.5 gal)
quietly ruins MPG history, so the confirm screen stays, at the cost of one tap.

## Flow

1. **App:** `GET /api/v1/me` → `features.receiptScanner`. Hide the button when
   it is `false` (feature off, or no API key on the server).
2. **App:** a CameraX capture, downscaled to about 1600 px on the long edge and
   saved as JPEG at ~80 % quality (a few hundred KB).
3. **App:** `POST /api/v1/fuel/receipt-scan` (multipart `file`, `vehicleId`).
4. **Server:** checks the user can edit the vehicle, saves the image as a
   `Document` with `purpose=RECEIPT`, sends it to the vision model with a
   strict JSON schema, validates the answer with zod, converts to stored units
   and returns a **draft**. Nothing is written to `FuelEntry`.
5. **App:** the quick fill-up screen opens prefilled from the draft. Fields with
   confidence below ~0.8 are highlighted, as is everything named in `warnings`.
   The odometer is prefilled from the last reading plus the average distance
   per day since then, for the user to confirm.
6. **App:** `POST /api/v1/fuel` with the confirmed fields plus
   `receiptDocumentId`. The server links the document to the new entry.

**Offline:** queue the photo and an "unscanned" outbox item. When the
connection is back, run the scan and notify the user to review and save the
draft. A failed scan (502) still returns the `documentId`, so the photo can be
attached to a manually entered fill-up.

## Endpoints

All endpoints need `Authorization: Bearer sgd_…` (device token); a web session
cookie is not accepted for writes (D-034). `Idempotency-Key` works as on every
other write (D-033): a retried scan replays the stored draft instead of
spending another model call.

### `GET /api/v1/me`

```json
{
  "user": { "…": "…" },
  "device": { "…": "…" },
  "preferences": { "…": "…" },
  "units": { "distance": "km", "volume": "l", "money": "cents" },
  "features": { "receiptScanner": true },
  "server": { "version": "…", "apiVersion": 1 }
}
```

### `POST /api/v1/fuel/receipt-scan`

Request: `multipart/form-data`

| Part        | Type   | Notes                                                                    |
|-------------|--------|--------------------------------------------------------------------------|
| `vehicleId` | string | A vehicle the user owns or edits (EDITOR share).                         |
| `file`      | file   | JPEG, PNG, WebP or GIF; content must match the declared type. ≤ 7 MB and ≤ `MAX_IMAGE_SIZE_MB`. PDFs are not scanned. |

Response `200`, a fuel receipt:

```json
{
  "documentId": "cmh3k2…",
  "isFuelReceipt": true,
  "draft": {
    "filledAtLocal": "2026-10-20T14:32:00",
    "liters": 43.464,
    "totalCostCents": 3972,
    "currency": "USD",
    "pricePerLiterCents": 91.377,
    "stationName": "Shell",
    "stationAddress": "123 Main St, Springfield",
    "fuelGrade": "Regular 87",
    "confidence": {
      "filledAtLocal": 0.9,
      "liters": 0.98,
      "totalCostCents": 0.99,
      "stationName": 0.9
    },
    "source": {
      "volume": { "value": 11.482, "unit": "gal" },
      "pricePerUnit": { "value": 3.459, "currency": "USD" },
      "total": { "value": 39.72, "currency": "USD" }
    }
  },
  "warnings": [],
  "model": "claude-sonnet-5-5",
  "scansRemainingToday": 29
}
```

Response `200`, not a fuel receipt (the photo is still saved as a document):

```json
{
  "documentId": "cmh3k2…",
  "isFuelReceipt": false,
  "draft": null,
  "warnings": ["not_fuel_receipt"],
  "model": "claude-sonnet-5-5",
  "scansRemainingToday": 28
}
```

Draft fields:

- `filledAtLocal` — the **local** date and time printed on the receipt,
  `YYYY-MM-DDTHH:MM:SS`, **no timezone**. The receipt doesn't say which zone it
  is in, the phone does: combine it with the device zone to build the
  `filledAt` for `POST /fuel`. `null` when unreadable. A receipt without a time
  gets `12:00:00` plus the `time_missing` warning.
- `liters` — litres, ≤ 3 decimals; gallons are already converted (US gallon
  3.785411784 L, imperial 4.54609 L). `null` when missing or implausible (> 500 L).
- `totalCostCents` — integer cents of `currency`. `null` when missing or ≤ 0.
- `currency` — ISO 4217. When the receipt doesn't name one, the user's
  preferred currency is used and `currency_assumed` is added.
- `pricePerLiterCents` — informational, cents per litre, ≤ 3 decimals; derived
  from the printed unit price (or total ÷ volume when only those exist).
- `stationName`, `stationAddress`, `fuelGrade` — as printed, or `null`.
  `fuelGrade` and `stationAddress` have no column of their own; put them in
  `note` if the user wants them kept.
- `confidence` — 0–1 for each draft field, keyed by draft field name; 0 when
  the field is `null`. Lowered to ≤ 0.5 by `total_mismatch` (volume and total),
  `time_missing` and `date_in_future` (date).
- `source` — the values as printed, before conversion, for the confirm screen
  ("11.482 gal @ $3.459").

`warnings` (string codes, any number, possibly empty):

| Code                  | Meaning                                                                      |
|-----------------------|------------------------------------------------------------------------------|
| `not_fuel_receipt`    | Only with `isFuelReceipt: false`.                                            |
| `volume_missing`, `total_missing`, `date_missing` | The receipt didn't show it or it was illegible.  |
| `time_missing`        | Date without a time; `filledAtLocal` says noon.                              |
| `total_mismatch`      | `volume × pricePerUnit` is off from the printed total by more than 2 %.      |
| `currency_assumed`    | `currency` is the user's preference, not read from the receipt.              |
| `currency_conflict`   | Unit price and total named different currencies; the total's was kept.       |
| `volume_implausible`, `total_implausible` | Value read but out of range; field set to `null`.        |
| `date_unreadable`     | The model returned a date that isn't a calendar date.                        |
| `date_in_future`      | More than a day in the future; kept, flag it.                                |

Errors (`{ "error": { "code", "message" } }`, D-030 rules):

| Status | `code`                   | When                                                                    |
|--------|--------------------------|-------------------------------------------------------------------------|
| 401    | `unauthorized`           | No or invalid device token.                                             |
| 404    | `not_found`              | Feature off on this server, **or** the vehicle isn't visible to the user. Treat both as "hide the button / tell the user to check the server". |
| 403    | `forbidden`              | Vehicle visible but view-only.                                          |
| 415    | `multipart_required`     | Body isn't `multipart/form-data`.                                       |
| 415    | `unsupported_file_type`  | Not JPEG/PNG/WebP/GIF, or the bytes don't match the declared type.      |
| 413    | `file_too_large`         | Over the receipt limit (7 MB) or `MAX_IMAGE_SIZE_MB`.                   |
| 422    | `validation_failed`      | `vehicleId` or `file` part missing.                                     |
| 429    | `rate_limited`           | Daily per-user limit reached (UTC day). `Retry-After` header in seconds. |
| 502    | `extraction_failed`      | Provider timeout/outage/refusal/unparseable answer. Body also carries `"documentId"` (the photo was saved) so the app can attach it manually. Never includes the provider's response. |

The daily limit counts every scan that reached the model, including failed
ones; the current count is reflected in `scansRemainingToday`.

### `POST /api/v1/fuel` with `receiptDocumentId`

Same body as before, plus the optional `receiptDocumentId` (the `documentId`
from the scan). Units are stored units (litres, integer cents, ISO 8601
`filledAt` with zone):

```json
{
  "vehicleId": "cmh3…",
  "filledAt": "2026-10-20T19:32:00.000Z",
  "odometerKm": 50000,
  "liters": 43.464,
  "totalCostCents": 3972,
  "currency": "USD",
  "stationName": "Shell",
  "receiptDocumentId": "cmh3k2…"
}
```

`201` with the fuel entry, as today. The document's `fuelEntryId` is set.
Errors: `404 not_found` when the document isn't on the same vehicle (or
doesn't exist); `409 document_already_linked` when it already belongs to
another fill-up. The entry is **not** created in either case.

### Documents

`Document` rows (`GET /api/v1/documents`, `/sync`) now carry `fuelEntryId`
(`null` unless linked). `GET /api/v1/documents?fuelEntryId=…` lists a
fill-up's receipt(s); `GET /api/v1/documents/{id}/content` serves the image.
Deleting the fill-up keeps the document and nulls `fuelEntryId`.

## Server configuration

Off by default: an install without these variables behaves exactly like
upstream, and `/me` reports `receiptScanner: false`.

| Variable                      | Default             | Description |
|-------------------------------|---------------------|-------------|
| `RECEIPT_SCANNER_ENABLED`     | `false`             | `true` turns the endpoint on (needs the key too). |
| `ANTHROPIC_API_KEY`           | unset               | Console API key (`sk-ant-…`). Billed separately from a Claude subscription. Server-side only. |
| `RECEIPT_SCANNER_MODEL`       | `claude-sonnet-5-5` | Any current vision-capable Claude model id. `claude-haiku-5-5` is the cheaper, slightly less accurate option. Checked against the models overview on 2026-10-22. |
| `RECEIPT_SCANNER_DAILY_LIMIT` | `30`                | Scans per user per UTC day. |
| `RECEIPT_SCANNER_EFFORT`      | `low`               | `output_config.effort` for the model call (`low`…`max`, or `off` to use the model's default). `low` is plenty for a receipt and keeps latency and cost down. |

## Implementation (server)

- **Migration `20261021120000_receipt_fuel_entry`** (additive): `Document.fuelEntryId`
  (`onDelete: SetNull`, indexed) added with `ALTER TABLE … ADD COLUMN`, on
  purpose instead of Prisma's table rebuild, so the `sync_tombstones`
  triggers on `Document` survive; plus the `ReceiptScan` table (one row per
  attempt: user, vehicle, document, outcome, model) that backs the daily limit
  and is an audit trail of what was sent to the model.
- **`lib/receipts/extract.ts`:** `ReceiptExtractor` interface and
  `claudeVisionExtractor` — plain `fetch` to `https://api.anthropic.com/v1/messages`
  (`x-api-key`, `anthropic-version: 2023-06-01`), one `user` message with the
  base64 image block then a short text block, a system prompt that demands
  only the JSON object, `output_config.format` with the JSON schema (structured
  output) and `effort`, `max_tokens: 4096`, 25 s timeout. No SDK dependency.
  The answer is zod-validated; `stop_reason` `refusal`/`max_tokens` and
  non-2xx are distinct `ReceiptExtractionError` kinds, logged as status + error
  type only.
- **`lib/receipts/draft.ts`:** pure conversion to the draft above, the
  ±2 % plausibility check, currency fallback and date normalization.
- **`lib/receipts/scan.ts`:** the handler (`createReceiptScanHandler` takes a
  fake extractor in tests); `lib/receipts/quota.ts` the UTC-day count;
  `lib/receipts/config.ts` the env parsing.

## Cost and billing

**API usage is billed separately from a Claude Max subscription,** through the
Anthropic Console with its own API key. Check current pricing there before
enabling it. A ~1600 px receipt photo is roughly 1,500–3,000 input tokens plus a
few hundred output tokens: well under a cent per scan on Sonnet 5.5, a fraction
of that on Haiku 5.5. The API key lives only on the server and never in the app.

## Privacy

Receipt images are sent to Anthropic for extraction. Receipts carry the
station, the time, and sometimes the last four digits of a card. The operator
turns this on deliberately (`RECEIPT_SCANNER_ENABLED`). Anthropic does not
store images beyond the request (vision docs) and doesn't train on API data.

## Tests

- **Unit** (`lib/receipts/extract.test.ts`, `draft.test.ts`): request shape,
  schema validation, provider/timeout/refusal/truncation mapping without
  leaking the key, unit conversion, the volume × price ≈ total check, currency
  fallback, date normalization. Fake `fetch`, no network.
- **Integration** (`lib/receipts/receipt-scan.int.test.ts`): the route with a
  fake extractor. Feature off → 404; draft shape and the saved RECEIPT
  document; viewer 403 / stranger 404; non-image, mislabeled and missing
  parts; daily limit 429 with `Retry-After`; provider failure 502 with
  `documentId`; `POST /fuel` linking (404 other vehicle, 409 already linked);
  `/me.features`.
- **Manual acceptance (open):** 10 real receipts from different chains,
  including crumpled and faded thermal paper. Target ≥ 9/10 with volume and
  total correct.

## Still to do

- Android: capture screen, prefilled quick fill-up, offline queue, attach-anyway
  path for `isFuelReceipt: false` and 502.
- Optional web UI: the same scan on the quick fill-up form (en + de strings).
- Manual acceptance run with real receipts; tune the prompt or switch
  `RECEIPT_SCANNER_MODEL` if it falls short.
