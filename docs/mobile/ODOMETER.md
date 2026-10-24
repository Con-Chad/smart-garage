# Odometer readings: server contract

Status: **server side implemented** (D-046). The app's odometer sheet and its
OBD-over-BLE reader both post here.

## `POST /api/v1/odometer`

Device token required; send an `Idempotency-Key` from the outbox as for every
write (D-023).

```json
{
  "vehicleId": "clx…",
  "odometerKm": 81234,
  "recordedAt": "2026-10-24T08:15:00.000Z",
  "note": null,
  "source": "obd"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `vehicleId` | string | Must be editable by the user (404 hidden, 403 view-only). |
| `odometerKm` | int ≥ 0 | Always km; convert miles before sending. |
| `recordedAt` | ISO 8601, optional | Defaults to now. |
| `note` | string ≤ 500, optional | |
| `source` | `"manual"` \| `"obd"`, optional | Defaults to `"manual"`. Anything else is 422 `validation_failed` (path `source`). |

**`manual`** (unchanged): always stored, also back-dated or lower readings;
`currentOdometerKm` only moves forward.

**`obd`**: must be **strictly higher** than both the vehicle's
`currentOdometerKm` and its newest reading (by `recordedAt`). It is written
through the web quick-update path (sets `currentOdometerKm`, logs the reading;
maintenance due-dates follow). Otherwise:

```http
HTTP/1.1 409 Conflict
{ "error": { "code": "odometer_not_higher",
             "message": "An OBD reading must be higher than the vehicle's current odometer and its newest reading" } }
```

The 409 is final: the outbox should drop the item (the server already has an
equal or newer value), not retry. A retry with the same `Idempotency-Key`
replays the original answer (201 with the created row, or the same 409).

Response: **201** with the reading in its read shape.

## Reads

`GET /api/v1/odometer` and `/api/v1/sync` (`changes.odometerLogs`) include
`source` on every row: `"manual"`, `"obd"` (the app's BLE reader) or
`"wican"` (the WiCAN adapter, D-045). Treat unknown values as manual.
