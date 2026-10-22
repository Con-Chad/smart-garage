# Decisions: mobile API fork

A running log of architecture decisions for the `con-chad/smart-garage` fork,
which adds a REST API (`/api/v1`) and UnifiedPush notifications for the Android
companion app. Newest entries go at the bottom of each section. The Phase 0
audit that motivated these lives in the parent project folder (`PHASE0-AUDIT.md`).

## Repository and workflow

- **D-001: Fork layout.** The fork's `main` carries our changes on top of an
  upstream release tag. Upstream is the `upstream` remote. Changes that should
  go back upstream (bug fixes, the provider refactor) are made as focused,
  separate commits so they can be cherry-picked onto a clean branch for a PR.
  *Why:* the existing CI and Docker workflows trigger on `main` and tags, so
  the fork publishes images without editing the trigger rules.
- **D-002: Image name derives from the repo owner.** `docker-publish.yml`
  uses `ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/smart-garage`.
  *Why:* GHCR names must be lowercase (`Con-Chad` becomes `con-chad`), and
  upstream keeps publishing to `flizzy27` with the same file, so the change is
  upstreamable.
- **D-003: Integration tests use a real SQLite database.** They live in
  `vitest.integration.config.ts` with `*.int.test.ts` files and run via
  `npm run test:integration`, which CI runs after the unit tests. A global
  setup migrates one template DB; each test file gets its own copy.
  *Why:* upstream has no DB tests, and ownership isolation can't be proven
  with mocks. Keeping a separate config leaves the 1.4s unit suite untouched.

## Product decisions (from Phase 0 review, 2026-10-20)

- **D-010: Shared editors get full write access** to a shared vehicle's fuel,
  maintenance, expenses, documents and notes. Viewers stay read-only. Today
  the web app limits those features to the owner. The change is made share-aware
  through `resolveVehicleAccess`, as its own upstreamable commit.
- **D-011: US defaults for new users.** Distance `mi`, volume `gal`, currency
  `USD`, locale `en`, and timezone `America/Chicago`. These are configurable through env
  (`DEFAULT_DISTANCE_UNIT`, `DEFAULT_VOLUME_UNIT`, `DEFAULT_CURRENCY`,
  `DEFAULT_LOCALE`, `DEFAULT_TIMEZONE`), and upstream keeps its current defaults
  when they're unset. **Storage stays metric** (km, liters, cents) and the API
  transfers metric plus the user's preferences.
  *Why:* changing stored units would break existing data and every upstream
  rebase. Display conversion already exists in `lib/regional/`.
- **D-012: Receipt scanner is deferred to after v1.** It will use server-side
  vision extraction through the Anthropic API, with an API key the operator
  configures and the feature off by default. Outline: `docs/mobile/RECEIPT-SCANNER.md`.
- **D-013: Inspection (HU/AU) and insurance push reminders are planned for
  v1.1** as new worker events. v1 pushes the same events Pushover/Telegram get
  today: maintenance overdue/due-soon and odometer reminders.

## Design (approved in Phase 0, D4)

- **D-020: Device tokens.** A new `ApiDevice` table stores sha256-hashed,
  long-lived, revocable tokens. `getCurrentUser()` falls back to
  `Authorization: Bearer` when there is no session cookie, so every existing
  service works for the API unchanged.
  *Why not reuse `Session`:* it stores tokens in plain text and expires them.
  *CSRF:* not a concern, because browsers never attach `Authorization` on
  their own.
- **D-021: Deletions are recorded** for offline sync in a `SyncTombstone`
  table, pruned after 90 days. Clients that are too far behind get `fullResync`.
- **D-022: Push uses UnifiedPush with RFC 8291 encryption** (the `web-push`
  package, `aes128gcm`). Registrations are stored per device with
  `p256dh`/`auth`. Delivery targets ntfy.sh for now. A registration is dropped
  on 404 or 410, or after three 507s in a row (ntfy's "no subscriber" code).
  Endpoints that aren't HTTPS or that resolve to private IPs are rejected
  unless `UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS=true`.
- **D-023: Writes are idempotent.** API writes accept a client-generated
  `clientId` so the app's offline outbox can retry safely.
- **D-024: Login rate limiting is in memory.** Failed sign-ins are counted per
  address and username (5 per 15 min) and per address (20 per 15 min), and
  the web form and `POST /api/v1/auth/login` share the same counters.
  *Why:* the app runs as a single container, so process memory needs no
  table or cleanup. Only failures count, so a correct password is never
  slowed down.
- **D-025: `/api/v1/health` is a separate endpoint.** It needs no
  authentication and leaves out the user/vehicle counts that `/api/health`
  exposes. It returns `service: "smart-garage"` so the app can tell Smart
  Garage apart from a Cloudflare Access login page answering in its place.
- **D-026: v1 also accepts the session cookie.** A browser session works for
  exploring the API while signed in to the web UI. Endpoints that act on
  "this device" (logout, and later push registration) require a device
  token.


## Read API (CP3)

- **D-027: Flat collections.** Every entity is a top-level collection
  (`/fuel`, `/records`, `/schedules`, ...) with `?vehicleId=` filters, plus
  `/{collection}/{id}`, instead of the nested paths sketched in Phase 0.
  One resource registry (`lib/api/v1/resources.ts`) defines visibility, wire
  shape and ordering for lists, detail and `/sync`, so the three can't
  disagree about who sees what.
  *Why:* the app reads almost everything through `/sync`; flat lists are
  simpler to keep consistent and to test exhaustively.
- **D-028: Sync protocol.** `GET /sync?since=` pages through every entity
  by `(updatedAt, id)` up to a snapshot `serverTime`, then returns
  `deletions` on the last page. The client stores `nextSince`. The server
  re-reads 5 s before `since` to cover writes that commit as a sync starts.
  Rows of a vehicle shared after `since` are sent even if old. Deletions come
  from tombstones, soft-deleted vehicles/documents and deactivated schedules.
  `fullResync: true` (first sync, `since` older than 90 days, or a backup
  import) tells the client to replace its local copy. Clients apply
  `changes`, then `deletions`, and cascade deletes locally like the
  database does.
- **D-029: Server-built views only where logic is non-trivial.**
  `/reminders` (due status, setup queue, inspections, insurance) and
  `/expenses/summary` are computed by the server. The dashboard and history
  timeline are composed by the app from synced data, which it needs offline
  anyway.
- **D-030: 404 hides, 403 explains.** Rows a user can't see are always 404,
  identical to "doesn't exist". 403 is used only when the user can see the
  vehicle but lacks the role: a viewer writing, or a non-owner managing shares.
- **D-031: Due-status refresh skips no-op writes.** Pages refresh every
  schedule on load; writing unchanged values would bump `updatedAt` and make
  every sync resend every schedule.
- **D-032: Credentials stay server-side.** `/notification-settings` reports
  `pushoverConfigured`/`telegramConfigured` instead of the tokens, and
  documents never expose `storageKey`.
- **D-033: `Idempotency-Key` header instead of a `clientId` field.**
  Supersedes the mechanism in D-023. The app sends a UUID per queued write in
  an `Idempotency-Key` header. Keys are scoped per user and kept for 7 days.
  A retry of the same request replays the stored response, marked
  `Idempotent-Replayed: true`, including a final 4xx. The same key with a
  different body gets 422. 5xx releases the key. Multipart bodies are
  fingerprinted by their parts, because clients pick a new boundary on each
  attempt.
  *Why:* it works the same way for every endpoint, including uploads and
  DELETE, without adding a column to each table. A header is also the
  convention clients already know (Stripe, the IETF draft).
  *Concurrent edits:* last write wins for now. PATCH merges onto the stored
  row, so it only changes the fields it sends. The conflict rule for edits
  made offline is decided before CP11.
- **D-034: API writes need a device token.** Reads also accept the web
  session cookie so the API can be explored in a browser. Writes don't.
  *Why:* `SameSite=Lax` treats sibling subdomains as same-site, so another
  app on the same domain could otherwise submit a form-encoded or multipart
  write with the user's cookie. The web UI uses server actions, never the API.
- **D-035: The app's write surface.** Every entity the web UI edits has a
  write endpoint. Exceptions: catalog-based vehicle setup, appearance
  settings, credentials (Pushover/Telegram), backup import/export and admin
  stay web-only. `POST /vehicles` is the web form's manual entry mode.
  Deleting a schedule deactivates it, as in the web UI. Enabling a push
  channel over the API requires its credentials to have been saved on the
  web first, so the API never makes the network check the web form does.

## Push (CP6)

- **D-036: Web Push (RFC 8291/8292) rather than a plaintext ntfy POST.**
  The server never talks to ntfy as ntfy; it talks Web Push to whatever
  endpoint the app's UnifiedPush distributor hands out. The message is
  encrypted end-to-end with the subscription's `p256dh`/`auth` keys
  (`aes128gcm`) and the request is signed with the server's VAPID key, so
  ntfy.sh (or any other distributor, including a self-hosted one later)
  relays ciphertext it cannot read, and the app can verify who sent it.
  *Why no `web-push` package:* the whole transport is ~120 lines of
  `node:crypto` (ECDH, HKDF, AES-GCM, ES256), which avoids a dependency with
  five transitive packages, keeps the image free of native modules, and is
  verified in tests against an independent decryptor written from the RFC.
  This supersedes the "`web-push` package" note in D-022.
- **D-037: Subscriptions live on `ApiDevice`.** `pushEndpoint`, `pushP256dh`,
  `pushAuth`, `pushCreatedAt`, `pushFailedAt`, `pushFailureCount` are
  nullable columns on the device row (additive migration). A device may only
  manage its own subscription over `PUT/DELETE /devices/{id}/push`: another
  user's device is 404 (hidden), the caller's other device 403 (D-030). All
  three push endpoints need a device token (D-034). Registering the same
  endpoint and keys again is a no-op; a new endpoint replaces the old one
  and resets the failure record. Revoking a device ends its push with it.
- **D-038: The VAPID key pair is generated once and stored in `AppSetting`**
  (`push.vapidPublicKey` / `push.vapidPrivateKey`), not read from env. A
  self-hoster never handles key material, and the pair survives restarts and
  image updates because it lives in the database. Two concurrent first calls
  race on the primary key and the loser adopts the winner's pair.
  `GET /api/v1/push/vapid` returns the public key. There is no rotation UI:
  rotating would invalidate every subscription. `PUSH_VAPID_SUBJECT`
  optionally sets the JWT `sub` contact (`mailto:` or `https:`).
- **D-039: Endpoint SSRF rules.** The server POSTs to a client-supplied URL,
  so the URL must be `https:` on port 443, without credentials or fragment,
  and its host must not be `localhost`/`.local`/`.internal`/`.lan`/a bare
  name, an IP literal in a private, loopback, link-local (incl.
  169.254.169.254), CGNAT, multicast or reserved range, or a name that
  resolves to one (every A/AAAA answer is checked; IPv4-mapped, NAT64 and
  6to4 forms are unwrapped). The check runs at registration **and again
  before every send**, so DNS rebinding after registration doesn't help.
  ntfy.sh, Mozilla autopush and any public UnifiedPush distributor pass.
  `UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS=true` (D-022) relaxes the address and
  port rules for a LAN-hosted distributor but keeps `https:`.
- **D-040: Cleanup and backoff.** 404 and 410 from the push service remove
  the subscription immediately; the test endpoint reports this as
  `push_subscription_gone` so the app re-registers. Any other failure stamps
  `pushFailedAt` and increments `pushFailureCount`; the device is then
  skipped for 15 min × 2^(n−1), capped at 24 h, and a 507 (ntfy: nobody is
  subscribed to the topic) on the third consecutive failure removes the
  subscription. A success resets the counter. The user-triggered test push
  ignores the backoff and is limited to 3 per device per 15 minutes.
- **D-041: Channel semantics.** "Mobile app (UnifiedPush)" is a third
  channel inside `dispatchToEnabledChannels`, so it inherits events,
  thresholds, delivery windows, quiet hours and the minimum interval
  unchanged. `mobilePushEnabled` defaults to **on** (the user already chose
  to install the app); the channel counts as enabled only while at least
  one active device has a subscription, so a user without the app sees no
  change in behaviour and the worker skips them as before. Every subscribed
  device of the user gets the message. The payload is small JSON
  (`type`, `title`, `body`, optional `vehicleId`/`scheduleId`, `url`) with
  nothing the notification text doesn't already say — no tokens, no
  credentials, no amounts beyond the text.

## Receipt scanner (fork feature, post-v1)

- **D-042: Receipt scanner, server side.** Implements D-012 as specified in
  `docs/mobile/RECEIPT-SCANNER.md`. *Off by default* (`RECEIPT_SCANNER_ENABLED`
  + `ANTHROPIC_API_KEY`); while off, `POST /api/v1/fuel/receipt-scan` is a
  plain 404 (D-030: indistinguishable from a route that doesn't exist) and
  `/me` reports `features.receiptScanner: false`, so upstream behaviour is
  unchanged. *Draft only:* the endpoint saves the photo as a `RECEIPT`
  document and returns a fill-up draft in stored units with per-field
  confidence and warnings; it never writes `FuelEntry`. The app saves with
  `POST /fuel` + `receiptDocumentId`, which links `Document.fuelEntryId` only
  when the document is on the same vehicle (404 otherwise, 409 if already
  linked). *Provider:* plain `fetch` to the Messages API behind a
  `ReceiptExtractor` interface (no SDK dependency; an on-device/OCR extractor
  can slot in). Default model `claude-sonnet-5-5` (current vision-capable
  Sonnet per the models overview, 2026-10-22), `effort: low`, structured
  output with the receipt JSON schema, 25 s timeout. Provider failures are a
  502 `extraction_failed` that still carries the `documentId`; the provider's
  body and the key never reach logs or clients. *Dates stay local:* the draft
  carries `filledAtLocal` without a zone because the receipt doesn't know its
  zone and the phone does. *Limit:* `RECEIPT_SCANNER_DAILY_LIMIT` (30) scans
  per user per UTC day, counted in the additive `ReceiptScan` table (also an
  audit trail of what was sent), 429 with `Retry-After`. *Migration:*
  `Document.fuelEntryId` is added with `ALTER TABLE … ADD COLUMN` instead of
  Prisma's table rebuild so the `sync_tombstones` triggers on `Document`
  survive; drift-checked with `prisma migrate diff --exit-code`.
