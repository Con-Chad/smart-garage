import { deleteDevicePush, putDevicePush } from "@/lib/api/v1/push";

export const dynamic = "force-dynamic";

/** Registers (PUT) or removes (DELETE) this device's Web Push / UnifiedPush subscription. */
export const PUT = putDevicePush;
export const DELETE = deleteDevicePush;
