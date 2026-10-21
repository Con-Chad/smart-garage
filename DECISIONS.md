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
  `USD`, locale `en`, and a US timezone. These are configurable through env
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
