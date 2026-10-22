# Push notifications: client contract (CP6 → CP12)

Smart Garage sends maintenance, odometer and (optionally) service/expense
alerts to the Android app as **Web Push** messages (RFC 8291 encryption,
RFC 8292 VAPID) through the **UnifiedPush** distributor installed on the
phone — ntfy for now. The server never sees the distributor's credentials and
the distributor never sees the message text.

This page is what the app has to implement. Base URL and device token come
from the sign-in flow (`POST /api/v1/auth/login`). Every endpoint below needs
`Authorization: Bearer sgd_…`; a web session cookie is not accepted.

## 1. Register

1. **Fetch the server's VAPID public key** (once per server, cache it):

   ```http
   GET /api/v1/push/vapid
   → 200 { "publicKey": "<87 chars base64url>", "algorithm": "ES256", "curve": "P-256" }
   ```

   The key is stable for the life of the installation. If it ever changes,
   re-register (step 3).

2. **Register with the distributor** using the UnifiedPush AndroidX
   connector, passing the VAPID key as the `vapid` parameter. The
   distributor calls back with a Web Push endpoint plus the subscription's
   `p256dh` and `auth` keys (the connector generates and stores these; the
   `auth` secret is 16 bytes, `p256dh` an uncompressed P-256 point).

3. **Tell the server** (replace `{deviceId}` with the `device.id` returned by
   login or `GET /api/v1/me`; a device may only register its own id):

   ```http
   PUT /api/v1/devices/{deviceId}/push
   Content-Type: application/json
   { "endpoint": "https://ntfy.sh/upXXXXXXXX?up=1",
     "keys": { "p256dh": "<base64url, 65 bytes>", "auth": "<base64url, 16 bytes>" } }

   → 200 { "push": { "deviceId": "…", "endpoint": "…", "createdAt": "…",
                     "failedAt": null, "failureCount": 0 } }
   → 401  no/invalid device token
   → 403  { "error": { "code": "forbidden" } }        another device of the same user
   → 404  { "error": { "code": "not_found" } }        someone else's device / unknown id
   → 422  { "error": { "code": "endpoint_rejected", "message": "Push endpoint rejected: …" } }
   → 422  { "error": { "code": "validation_failed", … } }  malformed body or keys
   ```

   The PUT is idempotent: sending the same endpoint and keys again returns
   200 with the original `createdAt`. A different endpoint replaces the old
   one. An `Idempotency-Key` header is accepted but not needed.

   `endpoint_rejected` means the URL failed the server's safety rules: it
   must be `https://` on port 443 and must not point at a private, loopback
   or link-local address (public distributors such as `https://ntfy.sh`
   always pass; a self-hosted distributor on the LAN needs the server to run
   with `UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS=true`). Show the message to the
   user; retrying with the same endpoint won't help.

## 2. When to re-register

Run step 3 again (it is cheap and idempotent) whenever:

- the distributor delivers a **new endpoint** (`onNewEndpoint`) — it does
  this after a reinstall, a distributor change, or on its own schedule;
- the app **starts** and the stored endpoint is older than a day (defensive);
- `POST …/push/test` or any sync response reports the subscription is gone
  (below);
- the user **re-enables** notifications in the app, or signs in again.

Call `DELETE /api/v1/devices/{deviceId}/push` (→ 204, also when nothing was
registered) when the user turns push off in the app or the distributor
reports `onUnregistered`. Signing out (`POST /api/v1/auth/logout`) revokes
the device, which ends its push too; no separate DELETE is needed.

## 3. Test push

```http
POST /api/v1/devices/{deviceId}/push/test
→ 200 { "ok": true, "deviceId": "…" }
→ 409 { "error": { "code": "push_not_registered" } }    register first
→ 429 Retry-After: <seconds>                            more than 3 per 15 min
→ 502 { "error": { "code": "push_subscription_gone", … } }  distributor says 404/410: re-register
→ 502 { "error": { "code": "push_failed", "message": "push service responded 503…" } }
```

The test message is a normal push with `type: "test"`, TTL 60 s. It ignores
the server's backoff for that device, so it is the right tool for "why
didn't I get anything?".

## 4. What arrives

The distributor hands the app the raw Web Push body. The UnifiedPush
connector (2.4+) decrypts it with the subscription keys and passes the
plaintext to `onMessage`. It is UTF-8 JSON:

```json
{ "type": "maintenance_due",
  "title": "2 maintenance items",
  "body": "• Honda Civic: Brake fluid — overdue (30 days past)\n• …",
  "vehicleId": "clx…",          // only when every item is about one vehicle
  "scheduleId": "clx…",         // only when there is exactly one item
  "url": "/maintenance" }
```

| `type`                | When                                              | `url`          |
| --------------------- | ------------------------------------------------- | -------------- |
| `maintenance_due`     | due-soon / overdue items (worker, every 15 min)   | `/maintenance` |
| `odometer_reminder`   | odometer reminder interval elapsed                | `/odometer`    |
| `maintenance_logged`  | a service was logged (if the user enabled it)     | `/maintenance` |
| `expense_added`       | an expense was added (if the user enabled it)     | `/expenses`    |
| `test`                | test push from the API or the web settings page   | `/`            |

Rules for the app:

- Show `title` and `body` as the notification text, `body` may contain
  newlines. Open the screen matching `url` (or the vehicle/schedule when the
  ids are present) on tap, then run a sync.
- The payload never contains tokens, credentials or anything the text
  doesn't already say. Treat unknown `type` values as a generic alert and
  still display them.
- Request headers the server sends: `Content-Encoding: aes128gcm`,
  `TTL: 86400` (60 for tests), `Urgency: high` for overdue items, otherwise
  `normal`. Messages are at most a few hundred bytes.

## 5. Settings the app can read and change

`GET /api/v1/notification-settings` now includes:

```json
{ "mobilePushEnabled": true, "mobilePushDevices": 2, … }
```

`PATCH /api/v1/notification-settings { "mobilePushEnabled": false }` turns
the channel off for all of the user's devices without unregistering them.
The flag defaults to **on**; the channel is live only while
`mobilePushDevices > 0`. `GET /api/v1/devices` lists every device with
`pushSubscribed`, `pushCreatedAt` and `pushFailedAt` (the endpoint URL is not
returned).

Delivery timing (quiet hours, scheduled window, minimum interval) is the
same as for Pushover and Telegram and is configured in the same settings.

## 6. Server-side behaviour the app should expect

- A 404 or 410 from the distributor **removes** the subscription at once.
  A 507 from ntfy (topic has no subscriber) removes it on the third
  consecutive failure. Other failures back off (15 min doubling to 24 h)
  and resume on their own.
- Everything is per device: a user with a phone and a tablet gets the
  message on both.
- Values to replace when testing by hand: the server URL
  `<<https://garage.example.com>>`, the device token `<<sgd_…>>`.
