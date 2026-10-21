"use server";

import { revalidatePath } from "next/cache";
import {
  createModificationForCurrentUser,
  deleteModificationForCurrentUser,
  updateModificationForCurrentUser,
} from "@/lib/services/modifications";
import { optionalEuroAmountSchema } from "@/lib/validations/money";

export type ModificationActionResult =
  | { success: true }
  | { success: false; error: string };

function optionalNumber(value: FormDataEntryValue | null): number | null {
  return value ? Number(value) : null;
}

/** Form fields (cost in euros) → the canonical input the service validates. */
function modificationInput(formData: FormData) {
  const costCents = optionalEuroAmountSchema.parse(formData.get("costEuros") || null);
  return {
    category: formData.get("category"),
    name: formData.get("name"),
    description: formData.get("description") || null,
    installedAt: formData.get("installedAt") || null,
    // The euro parser yields null for a malformed amount; reject that like before.
    costCents: costCents === null ? Number.NaN : (costCents ?? null),
    currency: formData.get("currency") || null,
    addedPowerKw: optionalNumber(formData.get("addedPowerKw")),
    addedPowerPs: optionalNumber(formData.get("addedPowerPs")),
    addedTorqueNm: optionalNumber(formData.get("addedTorqueNm")),
    notes: formData.get("notes") || null,
    isCustom: formData.get("isCustom") === "true",
  };
}

function revalidateVehicle(vehicleId: string) {
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath(`/vehicles/${vehicleId}/edit`);
}

export async function createModificationAction(
  vehicleId: string,
  _prev: ModificationActionResult | null,
  formData: FormData,
): Promise<ModificationActionResult> {
  try {
    const created = await createModificationForCurrentUser(vehicleId, modificationInput(formData));
    if (!created) return { success: false, error: "notFound" };
    revalidateVehicle(vehicleId);
    return { success: true };
  } catch {
    return { success: false, error: "validationFailed" };
  }
}

export async function updateModificationAction(
  vehicleId: string,
  modificationId: string,
  _prev: ModificationActionResult | null,
  formData: FormData,
): Promise<ModificationActionResult> {
  try {
    const updated = await updateModificationForCurrentUser(
      vehicleId,
      modificationId,
      modificationInput(formData),
    );
    if (!updated) return { success: false, error: "notFound" };
    revalidateVehicle(vehicleId);
    return { success: true };
  } catch {
    return { success: false, error: "validationFailed" };
  }
}

export async function deleteModificationAction(
  vehicleId: string,
  modificationId: string,
): Promise<ModificationActionResult> {
  const deleted = await deleteModificationForCurrentUser(vehicleId, modificationId);
  if (!deleted) return { success: false, error: "notFound" };
  revalidateVehicle(vehicleId);
  return { success: true };
}
