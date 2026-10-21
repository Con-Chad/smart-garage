"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  deleteInspectionForCurrentUser,
  saveInspectionForCurrentUser,
} from "@/lib/services/inspections";

/** Error codes the inspection form has messages for. */
const FORM_ERRORS = new Set(["invalidType", "invalidDate"]);

export async function saveInspectionAction(
  vehicleId: string,
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const lastRaw = String(formData.get("lastPerformedAt") ?? "");
    const result = await saveInspectionForCurrentUser(vehicleId, {
      type: String(formData.get("type")),
      nextDueAt: String(formData.get("nextDueAt") ?? ""),
      lastPerformedAt: lastRaw || null,
      reminderWeeksBefore: Number(formData.get("reminderWeeksBefore") ?? 4),
      stickerNumber: String(formData.get("stickerNumber") ?? "") || null,
      notes: String(formData.get("notes") ?? "") || null,
    });
    if (!result) return { ok: false, error: "notAllowed" };

    revalidatePath(`/vehicles/${vehicleId}`);
    revalidatePath("/reminders");
    return { ok: true };
  } catch (error) {
    const code = error instanceof ZodError ? error.issues[0]?.message : undefined;
    return { ok: false, error: code && FORM_ERRORS.has(code) ? code : "unknown" };
  }
}

export async function deleteInspectionFormAction(formData: FormData) {
  const inspectionId = String(formData.get("inspectionId") ?? "");
  const vehicleId = String(formData.get("vehicleId") ?? "");
  await deleteInspectionForCurrentUser(inspectionId);
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath("/reminders");
}
