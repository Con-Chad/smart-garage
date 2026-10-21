import { API_VERSION, apiError, apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { InvalidQueryError, parseLimit, parseSince } from "@/lib/api/v1/cursor";
import { loadApiScope } from "@/lib/api/v1/scope";
import {
  DEFAULT_SYNC_PAGE_SIZE,
  InvalidSyncCursorError,
  MAX_SYNC_PAGE_SIZE,
  pruneSyncTombstones,
  runSync,
} from "@/lib/api/v1/sync";
import { findPreferencesForUser } from "@/lib/repositories/preferences";
import { listTagsForOwner } from "@/lib/repositories/notes";
import { preferencesToApi } from "@/lib/api/v1/settings";

export const dynamic = "force-dynamic";

/**
 * `GET /api/v1/sync?since=<nextSince>` starts a sync; follow `cursor` with
 * `GET /api/v1/sync?cursor=…` while `hasMore` is true. Apply each page's
 * `changes` (upserts) and then its `deletions`. See `lib/api/v1/sync.ts`.
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  let since: Date | null;
  try {
    since = parseSince(url.searchParams.get("since"));
  } catch (error) {
    if (error instanceof InvalidQueryError) return apiError(400, "invalid_request", error.message);
    throw error;
  }
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_SYNC_PAGE_SIZE, MAX_SYNC_PAGE_SIZE);

  const scope = await loadApiScope(auth.user.id);
  let page;
  try {
    page = await runSync({ scope, since, cursor, limit });
  } catch (error) {
    if (error instanceof InvalidSyncCursorError) {
      return apiError(400, "invalid_cursor", "Unrecognized cursor; restart the sync without one");
    }
    throw error;
  }

  void pruneSyncTombstones().catch(() => {
    // Housekeeping only; a failed prune is retried on a later sync.
  });

  // Small, always-complete extras ride along on the first page of a session.
  const extras = cursor
    ? {}
    : await (async () => {
        const [preferences, noteTags] = await Promise.all([
          findPreferencesForUser(auth.user.id),
          listTagsForOwner(auth.user.id),
        ]);
        return {
          noteTags,
          preferences: preferencesToApi(preferences),
        };
      })();

  return apiJson({ apiVersion: API_VERSION, ...page, ...extras });
}
