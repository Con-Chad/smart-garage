import { NextResponse } from "next/server";
import { ingestWicanReading, readWicanPayload, wicanConfig } from "@/lib/ingest/wican";
import { isWicanAuthorized } from "@/lib/ingest/wican-auth";

export const dynamic = "force-dynamic";

/** WiCAN posts a few KB; the boot-time config dump is the largest. */
const MAX_BODY_BYTES = 256 * 1024;

const status = (code: number) => new NextResponse(null, { status: code });

/**
 * `POST /api/ingest/wican?vehicle=<id>` — odometer from a WiCAN OBD adapter.
 * Authenticated only by `Authorization: Bearer $WICAN_INGEST_TOKEN`, never by
 * session or device token. The body can carry the adapter's Wi-Fi credentials
 * (`config`/`status` on the first POST after boot): it is never logged and
 * only `autopid_data` is read. 204 whether or not a reading was written.
 */
export async function POST(request: Request) {
  const config = wicanConfig();
  if (!isWicanAuthorized(request.headers.get("authorization"), config.token)) {
    return status(401);
  }

  const vehicleId = new URL(request.url).searchParams.get("vehicle")?.trim();
  if (!vehicleId) return status(400);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return status(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return status(400);
  }

  const outcome = await ingestWicanReading(vehicleId, readWicanPayload(body), config);
  if (outcome === "vehicle_not_found") return status(404);
  return status(204);
}
