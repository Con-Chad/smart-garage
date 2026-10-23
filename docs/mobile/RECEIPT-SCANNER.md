# Receipt scanner: server contract

Status: **server side implemented** (D-012 planned it, D-042 records the
fuel implementation, D-044 adds service / vehicle-expense receipts — see
[Service receipts](#service-receipts-d-044)). The Android screen and offline queue code against this file.
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
  "features": { "receiptScanner": true, "receiptScannerKinds": ["fuel", "service"] },
  "server": { "version": "…", "apiVersion": 1 }
}
```

`receiptScanner` is `true` when any scan endpoint is available.
`receiptScannerKinds` lists which: `"fuel"` → `POST /api/v1/fuel/receipt-scan`,
`"service"` → `POST /api/v1/records/receipt-scan`. Both are `false` / `[]` when
the scanner is off. Older servers (before D-044) omit `receiptScannerKinds`;
treat a missing field with `receiptScanner: true` as `["fuel"]`.

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
fill-up's receipt(s); `?maintenanceRecordId=…` and `?expenseId=…` do the same
for service receipts (D-044); `GET /api/v1/documents/{id}/content` serves the
image. Deleting the fill-up / record / expense keeps the document and nulls
the link.

## Service receipts (D-044)

Workshop invoices, repair bills, parts and tyre receipts, and other vehicle
bills (insurance, tax, registration). The flow mirrors fuel: scan → draft →
the user confirms → the app saves with `POST /api/v1/records` (a maintenance
record) **or** `POST /api/v1/expenses` (a plain expense), passing
`receiptDocumentId`. Nothing is saved by the scan itself.

Shown only when `features.receiptScannerKinds` contains `"service"`.

### `POST /api/v1/records/receipt-scan`

Request: `multipart/form-data`, **identical to the fuel scan**:

| Part        | Type   | Notes                                                                    |
|-------------|--------|--------------------------------------------------------------------------|
| `vehicleId` | string | A vehicle the user owns or edits (EDITOR share).                         |
| `file`      | file   | JPEG, PNG, WebP or GIF; content must match the declared type. ≤ 7 MB and ≤ `MAX_IMAGE_SIZE_MB`. PDFs are not scanned. |

Headers, errors (401/403/404/413/415/422/429/502 with the same `code`s and the
502 `documentId`), the `Retry-After` on 429 and `Idempotency-Key` replay are
exactly as in the fuel table above. **The daily limit is shared**: fuel and
service scans count against the same `RECEIPT_SCANNER_DAILY_LIMIT`.

Response `200`, a service receipt:

```json
{
  "documentId": "cmh3k2…",
  "isServiceReceipt": true,
  "draft": {
    "performedAtLocal": "2026-10-15T12:00:00",
    "odometerKm": 48210,
    "vendorName": "Autohaus Müller",
    "vendorAddress": "Hauptstr. 1, 80331 München",
    "invoiceNumber": "R-2026-1042",
    "expenseCategory": "MAINTENANCE",
    "suggestedTarget": "record",
    "serviceTypes": [
      { "templateSlug": "oil_change", "name": "Engine oil & filter", "category": "ENGINE", "scheduleId": "cmh1sch…", "confidence": 0.95 },
      { "templateSlug": "cabin_filter", "name": "Cabin / pollen filter", "category": "FILTERS", "scheduleId": null, "confidence": 0.8 }
    ],
    "suggestedScheduleId": "cmh1sch…",
    "items": [
      { "category": "ENGINE_OIL", "name": "Motoröl 5W-30", "brand": "Castrol", "partNumber": null, "quantity": 4.5, "unit": "LITERS", "customUnit": null, "costCents": 6210, "currency": "EUR" },
      { "category": "OIL_FILTER", "name": "Ölfilter", "brand": "Mann", "partNumber": "HU 6004 x", "quantity": 1, "unit": "PIECES", "customUnit": null, "costCents": 1490, "currency": "EUR" }
    ],
    "otherLines": [
      { "kind": "labour", "description": "Arbeitslohn Inspektion", "amountCents": 12000 }
    ],
    "labourCents": 12000,
    "partsCents": 7700,
    "taxCents": 3743,
    "totalCostCents": 23443,
    "currency": "EUR",
    "note": "Invoice R-2026-1042\nArbeitslohn Inspektion: 120.00 EUR\nBremsbeläge hinten bei 3 mm",
    "confidence": {
      "performedAtLocal": 0.9,
      "odometerKm": 0.95,
      "totalCostCents": 0.98,
      "vendorName": 0.9,
      "serviceTypes": 0.85
    },
    "source": {
      "odometer": { "value": 48210, "unit": "km" },
      "total": 234.43
    }
  },
  "warnings": [],
  "model": "claude-sonnet-5-5",
  "scansRemainingToday": 27
}
```

Response `200`, not a service receipt (the photo is still saved as a document):

```json
{
  "documentId": "cmh3k2…",
  "isServiceReceipt": false,
  "draft": null,
  "warnings": ["fuel_receipt"],
  "model": "claude-sonnet-5-5",
  "scansRemainingToday": 26
}
```

`warnings` is `["fuel_receipt"]` for a fuel/charging receipt (offer to open
the fuel scan instead; that is a second scan) or `["not_service_receipt"]` for
anything that isn't a vehicle bill.

Draft fields (every field is always present; `null` when unknown):

| Field | Type | Meaning |
|-------|------|---------|
| `performedAtLocal` | string \| null | **Local** date/time on the receipt, `YYYY-MM-DDTHH:MM:SS`, no zone. Workshop invoices rarely print a time: then it is `12:00:00` and **no** `time_missing` warning is given. Combine with the device zone to build `performedAt` / `occurredAt`. |
| `odometerKm` | int \| null | Mileage printed on the invoice, in km (miles × 1.609344, rounded). `null` when not printed or out of range (→ `odometer_implausible`). |
| `vendorName`, `vendorAddress` | string \| null | Workshop / shop as printed. `vendorName` maps to `vendorName` on the record. |
| `invoiceNumber` | string \| null | As printed; also included in `note`. |
| `expenseCategory` | string | One of `MAINTENANCE`, `REPAIR`, `ACCESSORY`, `INSURANCE`, `TAX`, `REGISTRATION`, `OTHER` (the server's `ExpenseCategory` minus `FUEL`). Never `null`. |
| `suggestedTarget` | `"record"` \| `"expense"` | `"record"` when the category is `MAINTENANCE`/`REPAIR` or any service type was recognised; otherwise `"expense"`. A hint for which save screen to open; the user may switch. |
| `serviceTypes` | array | Maintenance types the work covers, sorted by `confidence` desc. `templateSlug` is a server maintenance template slug (`oil_change`, `air_filter`, `cabin_filter`, `fuel_filter`, `brake_fluid`, `coolant`, `transmission_fluid`, `spark_plugs`, `timing_belt`, `brake_pads`, `brake_discs`, `tire_rotation`, `tire_change_seasonal`, `hu_inspection`, `au_emissions`, `fuel_additive`, `adblue`, `wiper_blades`, `battery_check`, …); `name` is its English name and `category` its `MaintenanceCategory`. `scheduleId` is the vehicle's **active schedule** created from that template, or `null` if the vehicle has none (offer `POST /api/v1/schedules` with `templateId`, then save). Custom schedules (no template) are never matched; let the user pick one. |
| `suggestedScheduleId` | string \| null | `scheduleId` of the highest-confidence matched service type. Preselect it as `scheduleId` for `POST /records`. |
| `items` | array | Parts and fluids, already in the `items[]` shape of `POST /records` (`category`: `MaintenanceItemCategory`; `unit`: `MaintenanceItemUnit` or `null`; `costCents`: line total in integer cents or `null`; `currency`). Up to 40 (more → `items_truncated`). Send them as-is or after editing. |
| `otherLines` | array | Labour, fees, discounts and unclassified lines: `{ kind: "labour" \| "fee" \| "discount" \| "other", description, amountCents }` (`amountCents` negative for discounts). No column of their own; they are already summarised in `note`. |
| `labourCents`, `partsCents`, `taxCents` | int \| null | Subtotals as printed, integer cents. Informational. |
| `totalCostCents` | int \| null | Final amount payable incl. tax, integer cents of `currency`. Maps to `costCents` (record) or `amountCents` (expense). `null` when missing or ≤ 0. |
| `currency` | string \| null | ISO 4217; the user's preferred currency when the receipt didn't say (`currency_assumed`). |
| `note` | string \| null | Ready-made note: invoice number, `otherLines`, workshop advisories, one per line, ≤ 4000 chars. Fits record `note` (4000); **trim to 500** for expense `description`. |
| `confidence` | object | 0–1 for `performedAtLocal`, `odometerKm`, `totalCostCents`, `vendorName`, `serviceTypes`; 0 when the field is `null`/empty. `totalCostCents` ≤ 0.5 with `cost_breakdown_mismatch`; `performedAtLocal` ≤ 0.5 with `date_in_future`. |
| `source` | object | As printed before conversion: `odometer` `{ value, unit: "km" \| "mi" }` or `null`; `total` in currency units or `null`. |

`warnings` for service receipts:

| Code                      | Meaning                                                                  |
|---------------------------|--------------------------------------------------------------------------|
| `fuel_receipt`            | Only with `isServiceReceipt: false`: it's a fuel receipt.                |
| `not_service_receipt`     | Only with `isServiceReceipt: false`: not a vehicle bill.                 |
| `total_missing`, `date_missing` | Not shown or illegible.                                            |
| `total_implausible`, `odometer_implausible` | Read but out of range; field set to `null`.            |
| `date_unreadable`, `date_in_future` | As for fuel.                                                 |
| `currency_assumed`        | `currency` is the user's preference.                                     |
| `cost_breakdown_mismatch` | `labourCents + partsCents` (with or without `taxCents`) is more than 2 % off `totalCostCents`. |
| `service_type_unknown`    | `suggestedTarget` is `"record"` but no service type was recognised; ask the user for the schedule. |
| `no_matching_schedule`    | Service types were recognised but the vehicle has no schedule for any of them. |
| `items_truncated`         | More than 40 part/fluid lines; the rest were dropped.                    |

### Saving a service receipt

**As a maintenance record** — `POST /api/v1/records`, the existing body plus
the optional `receiptDocumentId`:

```json
{
  "scheduleId": "cmh1sch…",
  "performedAt": "2026-10-15T10:00:00.000Z",
  "odometerKm": 48210,
  "costCents": 23443,
  "currency": "EUR",
  "vendorName": "Autohaus Müller",
  "note": "Invoice R-2026-1042\nArbeitslohn Inspektion: 120.00 EUR\nBremsbeläge hinten bei 3 mm",
  "items": [ { "category": "ENGINE_OIL", "name": "Motoröl 5W-30", "brand": "Castrol", "quantity": 4.5, "unit": "LITERS", "costCents": 6210, "currency": "EUR" } ],
  "receiptDocumentId": "cmh3k2…"
}
```

`201` with the record; the document's `maintenanceRecordId` is set. The server
already creates a `MAINTENANCE` expense for any record with `costCents > 0`,
so **don't also `POST /expenses`** for the same receipt. When one invoice
covers several schedules (oil change + cabin filter), save the full total on
one record (`suggestedScheduleId`) with the receipt, and the others with
`costCents: 0` and no `receiptDocumentId` so their due dates still advance
without double-counting the cost.

**As an expense** (`suggestedTarget: "expense"`) — `POST /api/v1/expenses`,
the existing body plus `receiptDocumentId`:

```json
{
  "vehicleId": "cmh3…",
  "category": "INSURANCE",
  "occurredAt": "2026-10-15T10:00:00.000Z",
  "amountCents": 45000,
  "currency": "EUR",
  "odometerKm": null,
  "description": "Invoice 2026-77",
  "receiptDocumentId": "cmh3k2…"
}
```

`201`; the document's `expenseId` is set.

Errors for both, same as `POST /fuel`: `404 not_found` when the document isn't
on the same vehicle (for records: the schedule's vehicle) or doesn't exist;
`409 document_already_linked` when it is already linked to another record
(resp. expense). Nothing is created in either case. A receipt may be linked to
one fill-up, one record and one expense independently.

## Server configuration

Off by default: an install without these variables behaves exactly like
upstream, and `/me` reports `receiptScanner: false`.

| Variable                      | Default             | Description |
|-------------------------------|---------------------|-------------|
| `RECEIPT_SCANNER_ENABLED`     | `false`             | `true` turns the endpoint on (needs the key too). |
| `ANTHROPIC_API_KEY`           | unset               | Console API key (`sk-ant-…`). Billed separately from a Claude subscription. Server-side only. |
| `RECEIPT_SCANNER_MODEL`       | `claude-sonnet-5-5` | Any current vision-capable Claude model id. `claude-haiku-5-5` is the cheaper, slightly less accurate option. Checked against the models overview on 2026-10-22. |
| `RECEIPT_SCANNER_DAILY_LIMIT` | `30`                | Scans per user per UTC day, fuel and service combined. |
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
- **`lib/receipts/scan.ts`:** one shared handler skeleton (`createScanHandler`)
  and the two kinds: `createReceiptScanHandler` (fuel) and
  `createServiceReceiptScanHandler` (service, D-044); both take a fake
  extractor in tests. `lib/receipts/quota.ts` the UTC-day count;
  `lib/receipts/config.ts` the env parsing and `/me` features.
- **`lib/receipts/service-extract.ts`** (D-044): the service prompt, JSON
  schema (template slugs, item categories and units as enums) and zod
  validation; same `requestVisionJson` call as fuel.
- **`lib/receipts/service-draft.ts`** (D-044): pure conversion to the service
  draft: cents, km, schedule matching by template slug, items/other lines,
  note, warnings.
- **Linking:** `receiptDocumentId` on `POST /fuel`, `/records`, `/expenses`
  (`lib/api/v1/mutations.ts`, `assertLinkableReceipt` + `linkReceipt`).

## Cost and billing

**API usage is billed separately from a Claude Max subscription,** through the
Anthropic Console with its own API key. Check current pricing there before
enabling it. A ~1600 px receipt photo is roughly 1,500–3,000 input tokens plus a
few hundred output tokens: well under a cent per scan on Sonnet 5.5, a fraction
of that on Haiku 5.5. The API key lives only on the server and never in the app.

## Privacy

Receipt images are sent to Anthropic for extraction. Receipts carry the
station, the time, and sometimes the last four digits of a card; workshop
invoices (D-044) usually also show the customer's name, address and number
plate. Only the image is sent: no vehicle or schedule data from the server
goes to the model, and the prompt tells it not to copy personal data into
`notes`. The operator
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
- **Service (D-044)** (`service-extract.test.ts`, `service-draft.test.ts`,
  `service-receipt-scan.int.test.ts`): request shape and error mapping,
  slug/enum filtering, cents/km conversion, schedule matching, breakdown
  check, fuel/non-vehicle answers, shared quota, 502, linking via
  `POST /records` and `POST /expenses` (404/409), `/me.features.receiptScannerKinds`.
- **Manual acceptance (open):** 10 real receipts from different chains,
  including crumpled and faded thermal paper. Target ≥ 9/10 with volume and
  total correct.

## Still to do

- Android: capture screen, prefilled quick fill-up, offline queue, attach-anyway
  path for `isFuelReceipt: false` and 502.
- Android: service receipt scan → prefilled "log service" / "add expense"
  screen (D-044), schedule picker preselected from `suggestedScheduleId`.
- Manual acceptance for service receipts (workshop invoices, tyre shop,
  insurance bill).
- Optional web UI: the same scan on the quick fill-up form (en + de strings).
- Manual acceptance run with real receipts; tune the prompt or switch
  `RECEIPT_SCANNER_MODEL` if it falls short.
