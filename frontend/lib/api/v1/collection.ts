import { apiError, apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { decodeCursor, encodeCursor, listCursorSchema, parseLimit } from "@/lib/api/v1/cursor";
import { RESOURCES, type ResourceKey } from "@/lib/api/v1/resources";
import { loadApiScope } from "@/lib/api/v1/scope";

/**
 * `GET /api/v1/<collection>?limit=&cursor=&<filter>=` — newest first (or the
 * collection's natural order), keyset-paginated so inserts between pages
 * never cause skips or duplicates.
 */
export async function listResource(request: Request, key: ResourceKey) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const def = RESOURCES[key];
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const { field, direction } = def.listOrder;
  const op = direction === "desc" ? "lt" : "gt";

  const conditions: object[] = [];
  for (const name of def.filters ?? []) {
    const value = url.searchParams.get(name);
    if (value) conditions.push({ [name]: value });
  }

  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor, listCursorSchema);
    if (!cursor) return apiError(400, "invalid_cursor", "Unrecognized cursor");
    const value = cursor.d ? new Date(String(cursor.v)) : cursor.v;
    conditions.push({
      OR: [{ [field]: { [op]: value } }, { [field]: value, id: { [op]: cursor.i } }],
    });
  }

  const scope = await loadApiScope(auth.user.id);
  const rows = await def.find({
    where: { AND: [def.visible(scope), ...conditions] },
    orderBy: [{ [field]: direction }, { id: direction }],
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1) as Record<string, unknown> | undefined;
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const sortValue = last[field];
    nextCursor = encodeCursor({
      v: sortValue instanceof Date ? sortValue.toISOString() : sortValue,
      d: sortValue instanceof Date,
      i: last.id,
    });
  }

  return apiJson({
    items: page.map((row) => def.toApi(row, scope)),
    nextCursor,
  });
}

/** `GET /api/v1/<collection>/{id}`; 404 for missing rows and rows the user can't see alike. */
export async function getResource(key: ResourceKey, id: string) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const def = RESOURCES[key];
  const scope = await loadApiScope(auth.user.id);
  const [row] = await def.find({
    where: { AND: [def.visible(scope), { id }] },
    orderBy: [],
    take: 1,
  });
  if (!row) return apiError(404, "not_found", "Not found");
  return apiJson(def.toApi(row, scope));
}

type IdContext = { params: Promise<{ id: string }> };

/** Route-file shorthands: `export const GET = listRoute("fuelEntries")`. */
export function listRoute(key: ResourceKey) {
  return (request: Request) => listResource(request, key);
}

export function itemRoute(key: ResourceKey) {
  return async (_request: Request, context: IdContext) =>
    getResource(key, (await context.params).id);
}
