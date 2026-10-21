import { getCurrentUserId } from "@/lib/auth/current-user";
import { deleteInspection, upsertInspection } from "@/lib/repositories/inspections";
import { inspectionInputSchema } from "@/lib/validations/inspection";

/**
 * Creates or replaces the vehicle's inspection of that type (one HU and one
 * AU per vehicle). Throws ZodError on invalid input; returns null when the
 * user may not edit the vehicle.
 */
export async function saveInspectionForCurrentUser(vehicleId: string, input: unknown) {
  const data = inspectionInputSchema.parse(input);
  const userId = await getCurrentUserId();
  return upsertInspection(vehicleId, userId, {
    ...data,
    lastPerformedAt: data.lastPerformedAt ?? null,
  });
}

/** Returns false when the inspection doesn't exist or the user may not edit it. */
export async function deleteInspectionForCurrentUser(inspectionId: string): Promise<boolean> {
  const userId = await getCurrentUserId();
  const result = await deleteInspection(inspectionId, userId);
  return result.count > 0;
}
