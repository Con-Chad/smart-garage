import { ZodError, type z } from "zod";
import type { CurrentApiDevice, CurrentUser } from "@/lib/auth/current-user";
import { apiError, apiJson, requireApiDevice } from "@/lib/api/v1/http";
import { withIdempotency } from "@/lib/api/v1/idempotency";
import { RESOURCES, type ResourceKey } from "@/lib/api/v1/resources";
import { loadApiScope, type ApiScope } from "@/lib/api/v1/scope";
import { getMaxUploadSizeBytes } from "@/lib/storage/paths";

/**
 * Shared plumbing for `/api/v1` writes: auth, `Idempotency-Key`, mapping
 * service errors to HTTP, and 404-vs-403 access checks (D-030). Handlers
 * validate with zod and call the same services the web actions use.
 */

export type WriteContext = {
  request: Request;
  user: CurrentUser;
  device: CurrentApiDevice;
  scope: ApiScope;
};

/** Thrown by handlers to return an error response from deep inside. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Writes need a device token. Reads also accept the web session cookie, but
 * a cookie-authenticated write would be open to CSRF from sibling subdomains
 * (SameSite=Lax treats them as same-site), and the web UI never needs it.
 */
export async function handleWrite(
  request: Request,
  handler: (ctx: WriteContext) => Promise<Response>,
): Promise<Response> {
  const auth = await requireApiDevice();
  if (!auth.ok) return auth.response;

  return withIdempotency(request, auth.user.id, async () => {
    try {
      const scope = await loadApiScope(auth.user.id);
      return await handler({ request, user: auth.user, device: auth.device, scope });
    } catch (error) {
      return writeErrorResponse(error);
    }
  });
}

/** Service error messages that mean "that row doesn't exist for you". */
const NOT_FOUND_MESSAGES = new Set([
  "VEHICLE_NOT_FOUND",
  "Vehicle not found",
  "Schedule not found",
  "Record not found",
  "Note not found",
  "FUEL_ENTRY_NOT_FOUND",
  "EXPENSE_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "ODOMETER_LOG_NOT_FOUND",
  "MAINTENANCE_RECORD_NOT_FOUND",
  "Maintenance record not found",
  "CATALOG_NOT_FOUND",
]);

export function writeErrorResponse(error: unknown): Response {
  if (error instanceof ApiProblem) return apiError(error.status, error.code, error.message);
  if (error instanceof ZodError) {
    return apiJson(
      {
        error: {
          code: "validation_failed",
          message: "The request body is invalid",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 422 },
    );
  }
  if (error instanceof Error) {
    if (NOT_FOUND_MESSAGES.has(error.message)) return apiError(404, "not_found", "Not found");
    if (error.message === "INVALID_FILE_TYPE") {
      return apiError(415, "unsupported_file_type", "Only JPEG, PNG, WebP, GIF and PDF files are accepted, and the content must match the type");
    }
    if (error.message === "FILE_TOO_LARGE") {
      return apiError(413, "file_too_large", "The file exceeds the upload size limit");
    }
    if (error.message === "ODOMETER_INVALID") {
      return apiError(422, "validation_failed", "odometerKm must be a non-negative number");
    }
  }
  throw error;
}

const MAX_JSON_BYTES = 1024 * 1024;

/** Parses and validates a JSON body; 400 for malformed JSON, 413 when huge, 422 when invalid. */
export async function parseJsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BYTES) throw new ApiProblem(413, "body_too_large", "JSON bodies are limited to 1 MiB");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new ApiProblem(413, "body_too_large", "JSON bodies are limited to 1 MiB");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiProblem(400, "invalid_json", "The request body is not valid JSON");
  }
  return schema.parse(body);
}

/** Parses a multipart body after checking the declared size against the upload limit. */
export async function parseMultipart(request: Request): Promise<FormData> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new ApiProblem(415, "multipart_required", "Send the file as multipart/form-data");
  }
  // Headroom for the other form fields and multipart framing.
  const limit = getMaxUploadSizeBytes() + 1024 * 1024;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > limit) throw new ApiProblem(413, "file_too_large", "The file exceeds the upload size limit");
  try {
    return await request.formData();
  } catch {
    throw new ApiProblem(400, "invalid_multipart", "The multipart body could not be parsed");
  }
}

/** 404 when the user can't see the vehicle, 403 when they can but may not edit it. */
export function assertCanEditVehicle(scope: ApiScope, vehicleId: string) {
  const grant = scope.grants.get(vehicleId);
  if (!grant) throw new ApiProblem(404, "not_found", "Not found");
  if (!grant.canEdit) {
    throw new ApiProblem(403, "forbidden", "You have view-only access to this vehicle");
  }
}

export function assertOwnsVehicle(scope: ApiScope, vehicleId: string) {
  const grant = scope.grants.get(vehicleId);
  if (!grant) throw new ApiProblem(404, "not_found", "Not found");
  if (grant.role !== "OWNER") {
    throw new ApiProblem(403, "forbidden", "Only the vehicle's owner can do this");
  }
}

/** A visible row of a resource, as the raw database row; throws 404 when invisible. */
export async function findVisibleRow<R = Record<string, unknown>>(
  scope: ApiScope,
  key: ResourceKey,
  id: string,
): Promise<R> {
  const def = RESOURCES[key];
  const [row] = await def.find({ where: { AND: [def.visible(scope), { id }] }, orderBy: [], take: 1 });
  if (!row) throw new ApiProblem(404, "not_found", "Not found");
  return row as R;
}

/** Looks up a row the user can see and requires edit rights on its vehicle. */
export async function findEditableRow<R extends { vehicleId: string | null }>(
  scope: ApiScope,
  key: ResourceKey,
  id: string,
): Promise<R> {
  const row = await findVisibleRow<R>(scope, key, id);
  if (row.vehicleId) assertCanEditVehicle(scope, row.vehicleId);
  return row;
}

/** Responds with a resource in its read (GET) shape, so writes and reads match. */
export async function respondWithResource(
  scope: ApiScope,
  key: ResourceKey,
  id: string,
  status = 200,
): Promise<Response> {
  const def = RESOURCES[key];
  const [row] = await def.find({ where: { AND: [def.visible(scope), { id }] }, orderBy: [], take: 1 });
  if (!row) throw new ApiProblem(404, "not_found", "Not found");
  return apiJson(def.toApi(row, scope), { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
