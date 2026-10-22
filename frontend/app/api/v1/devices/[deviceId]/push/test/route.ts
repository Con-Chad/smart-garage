import { testDevicePush } from "@/lib/api/v1/push";

export const dynamic = "force-dynamic";

/** Sends a test push to this device (rate-limited). */
export const POST = testDevicePush;
