import { getCurrentUserId } from "@/lib/auth/current-user";
import { MAX_CUSTOM_FIELDS_PER_USER } from "@/lib/domain/custom-fields";
import {
  createCustomFieldForUser,
  deleteCustomFieldForUser,
  listCustomFieldsForUser,
  saveCustomFieldValuesForVehicle,
  updateCustomFieldForUser,
} from "@/lib/repositories/custom-fields";
import { resolveVehicleAccess } from "@/lib/vehicles/access";
import { customFieldInputSchema, customFieldValuesSchema } from "@/lib/validations/custom-field";

export class TooManyCustomFieldsError extends Error {
  constructor() {
    super("tooManyFields");
  }
}

/** Throws ZodError on invalid input and TooManyCustomFieldsError past the per-user limit. */
export async function createCustomFieldForCurrentUser(input: unknown) {
  const data = customFieldInputSchema.parse(input);
  const userId = await getCurrentUserId();
  const existing = await listCustomFieldsForUser(userId);
  if (existing.length >= MAX_CUSTOM_FIELDS_PER_USER) throw new TooManyCustomFieldsError();
  return createCustomFieldForUser(userId, data);
}

/** Returns false when the field isn't the user's. */
export async function updateCustomFieldForCurrentUser(fieldId: string, input: unknown) {
  const data = customFieldInputSchema.parse(input);
  const userId = await getCurrentUserId();
  return updateCustomFieldForUser(userId, fieldId, data);
}

export async function deleteCustomFieldForCurrentUser(fieldId: string) {
  const userId = await getCurrentUserId();
  return deleteCustomFieldForUser(userId, fieldId);
}

/**
 * Sets custom-field values on a vehicle. Values belong to the vehicle owner's
 * field definitions, so a shared editor fills in the owner's fields; unknown
 * field ids are ignored. Returns false when the user may not edit the vehicle.
 */
export async function saveCustomFieldValuesForCurrentUser(vehicleId: string, input: unknown) {
  const values = customFieldValuesSchema.parse(input);
  const userId = await getCurrentUserId();
  const access = await resolveVehicleAccess(userId, vehicleId);
  if (!access?.canEdit) return false;
  await saveCustomFieldValuesForVehicle(access.ownerUserId, vehicleId, values);
  return true;
}
