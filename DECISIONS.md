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
