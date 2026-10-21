"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUserId } from "@/lib/auth/current-user";
import { revokeApiDeviceForUser } from "@/lib/repositories/api-devices";

export async function revokeApiDeviceAction(formData: FormData): Promise<void> {
  const userId = await getCurrentUserId();
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return;

  await revokeApiDeviceForUser(userId, deviceId);
  revalidatePath("/[locale]/settings/devices", "page");
}
