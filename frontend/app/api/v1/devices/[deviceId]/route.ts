import { NextResponse } from "next/server";
import { apiError, requireApiAuth } from "@/lib/api/v1/http";
import { revokeApiDeviceForUser } from "@/lib/repositories/api-devices";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deviceId: string }>;
};

/** Revokes one of the caller's devices; another user's device is a 404. */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const { deviceId } = await context.params;
  const revoked = await revokeApiDeviceForUser(auth.user.id, deviceId);
  if (!revoked) return apiError(404, "not_found", "Device not found or already revoked");

  return new NextResponse(null, { status: 204 });
}
