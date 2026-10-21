import { NextResponse } from "next/server";
import {
  getCurrentApiDevice,
  getCurrentUser,
  type CurrentApiDevice,
  type CurrentUser,
} from "@/lib/auth/current-user";

/** Bumped only for breaking changes to `/api/v1` response shapes. */
export const API_VERSION = 1;

/**
 * JSON response that tolerates Prisma `BigInt` columns (money in cents, file
 * sizes). Values stay far below 2^53, so they are sent as plain numbers.
 */
export function apiJson(data: unknown, init?: ResponseInit): NextResponse {
  const body = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? Number(value) : value,
  );
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new NextResponse(body, { ...init, headers });
}

/** Uniform error shape: `{ "error": { "code": "…", "message": "…" } }`. */
export function apiError(
  status: number,
  code: string,
  message: string,
  init?: { headers?: HeadersInit },
): NextResponse {
  return apiJson({ error: { code, message } }, { status, headers: init?.headers });
}

export type ApiAuth =
  | { ok: true; user: CurrentUser; device: CurrentApiDevice | null }
  | { ok: false; response: NextResponse };

/**
 * Authenticates an `/api/v1` request. Device tokens are the normal path; a
 * browser session cookie also works so the API can be explored while signed
 * in to the web UI. `device` is null for cookie-authenticated requests.
 */
export async function requireApiAuth(): Promise<ApiAuth> {
  const device = await getCurrentApiDevice();
  if (device) return { ok: true, user: device.user, device };

  const user = await getCurrentUser();
  if (user) return { ok: true, user, device: null };

  return {
    ok: false,
    response: apiError(401, "unauthorized", "Missing, invalid or revoked credentials"),
  };
}

/** Like `requireApiAuth`, but only accepts device tokens. */
export async function requireApiDevice(): Promise<
  { ok: true; user: CurrentUser; device: CurrentApiDevice } | { ok: false; response: NextResponse }
> {
  const device = await getCurrentApiDevice();
  if (device) return { ok: true, user: device.user, device };
  return {
    ok: false,
    response: apiError(401, "unauthorized", "A device token is required for this endpoint"),
  };
}

/** Parses a JSON body, returning null for a missing or malformed body. */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
