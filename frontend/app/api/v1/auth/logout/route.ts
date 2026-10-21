import { NextResponse } from "next/server";
import { requireApiDevice } from "@/lib/api/v1/http";
import { revokeApiDeviceForUser } from "@/lib/repositories/api-devices";

export const dynamic = "force-dynamic";

/** Revokes the device token used for this request. */
export async function POST() {
  const auth = await requireApiDevice();
  if (!auth.ok) return auth.response;

  await revokeApiDeviceForUser(auth.user.id, auth.device.id);
  return new NextResponse(null, { status: 204 });
}
