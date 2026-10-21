import { getCurrentUserId } from "@/lib/auth/current-user";
import {
  addVehicleShare,
  removeVehicleShare,
  updateVehicleShareRole,
} from "@/lib/repositories/vehicle-shares";
import { shareRoleSchema, shareVehicleInputSchema } from "@/lib/validations/sharing";

/** Owner only. Re-sharing with the same user updates their role. Throws ZodError on bad input. */
export async function shareVehicleForCurrentUser(vehicleId: string, input: unknown) {
  const data = shareVehicleInputSchema.parse(input);
  const ownerUserId = await getCurrentUserId();
  return addVehicleShare(vehicleId, ownerUserId, data.username, data.role);
}

export async function updateShareRoleForCurrentUser(shareId: string, role: unknown) {
  const parsedRole = shareRoleSchema.parse(role);
  const ownerUserId = await getCurrentUserId();
  const result = await updateVehicleShareRole(shareId, ownerUserId, parsedRole);
  return result.count > 0;
}

export async function removeShareForCurrentUser(shareId: string) {
  const ownerUserId = await getCurrentUserId();
  const result = await removeVehicleShare(shareId, ownerUserId);
  return result.count > 0;
}
