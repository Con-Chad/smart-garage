import { getCurrentUserId } from "@/lib/auth/current-user";
import {
  createModification,
  deleteModification,
  updateModification,
} from "@/lib/repositories/modifications";
import { findEditableVehicle } from "@/lib/repositories/vehicles";
import { modificationInputSchema, type ModificationInputData } from "@/lib/validations/modification";

function toRepositoryInput(data: ModificationInputData) {
  return {
    ...data,
    installedAt: data.installedAt ?? null,
    costCents: data.costCents != null ? BigInt(data.costCents) : null,
    isCustom: data.isCustom ?? false,
  };
}

/**
 * Modifications are part of the vehicle, so owners and shared editors may
 * change them. Each function returns null/false when the user may not edit
 * the vehicle (or the modification isn't on it) and throws ZodError on
 * invalid input.
 */
export async function createModificationForCurrentUser(vehicleId: string, input: unknown) {
  const data = modificationInputSchema.parse(input);
  const userId = await getCurrentUserId();
  if (!(await findEditableVehicle(vehicleId, userId))) return null;
  return createModification({ vehicleId, ...toRepositoryInput(data) });
}

export async function updateModificationForCurrentUser(
  vehicleId: string,
  modificationId: string,
  input: unknown,
): Promise<boolean> {
  const data = modificationInputSchema.parse(input);
  const userId = await getCurrentUserId();
  if (!(await findEditableVehicle(vehicleId, userId))) return false;
  const result = await updateModification(modificationId, vehicleId, toRepositoryInput(data));
  return result.count > 0;
}

export async function deleteModificationForCurrentUser(
  vehicleId: string,
  modificationId: string,
): Promise<boolean> {
  const userId = await getCurrentUserId();
  if (!(await findEditableVehicle(vehicleId, userId))) return false;
  const result = await deleteModification(modificationId, vehicleId);
  return result.count > 0;
}
