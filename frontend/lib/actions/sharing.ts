"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { VehicleShareRole } from "@prisma/client";
import {
  removeShareForCurrentUser,
  shareVehicleForCurrentUser,
  updateShareRoleForCurrentUser,
} from "@/lib/services/sharing";

export async function shareVehicleAction(
  vehicleId: string,
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await shareVehicleForCurrentUser(vehicleId, {
      username: String(formData.get("username") ?? ""),
      role: String(formData.get("role") ?? "VIEWER"),
    });
    if ("error" in result && result.error) {
      return { ok: false, error: result.error };
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const code = error.issues[0]?.message;
      return { ok: false, error: code === "userNotFound" ? code : "unknown" };
    }
    throw error;
  }

  revalidatePath(`/vehicles/${vehicleId}`);
  return { ok: true };
}

export async function removeShareFormAction(formData: FormData) {
  const shareId = String(formData.get("shareId") ?? "");
  const vehicleId = String(formData.get("vehicleId") ?? "");
  await removeShareForCurrentUser(shareId);
  revalidatePath(`/vehicles/${vehicleId}`);
}

export async function updateShareRoleAction(
  shareId: string,
  vehicleId: string,
  role: VehicleShareRole,
): Promise<{ ok: boolean }> {
  const ok = await updateShareRoleForCurrentUser(shareId, role);
  revalidatePath(`/vehicles/${vehicleId}`);
  return { ok };
}
