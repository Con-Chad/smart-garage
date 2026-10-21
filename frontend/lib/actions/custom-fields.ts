"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  TooManyCustomFieldsError,
  createCustomFieldForCurrentUser,
  deleteCustomFieldForCurrentUser,
  updateCustomFieldForCurrentUser,
} from "@/lib/services/custom-fields";

export type CustomFieldActionResult = {
  ok: boolean;
  error?: string;
};

function fieldInput(formData: FormData) {
  return {
    label: String(formData.get("label") ?? ""),
    fieldType: formData.get("fieldType"),
    unit: String(formData.get("unit") ?? ""),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof ZodError) {
    const code = error.issues[0]?.message;
    return code === "labelRequired" || code === "labelTooLong" ? code : "failed";
  }
  if (error instanceof TooManyCustomFieldsError) return "tooManyFields";
  return "failed";
}

function revalidateVehicleViews() {
  revalidatePath("/settings/vehicle-fields");
  revalidatePath("/vehicles");
}

export async function createCustomFieldAction(
  _prev: CustomFieldActionResult | null,
  formData: FormData,
): Promise<CustomFieldActionResult> {
  try {
    await createCustomFieldForCurrentUser(fieldInput(formData));
    revalidateVehicleViews();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorCode(error) };
  }
}

export async function updateCustomFieldAction(
  _prev: CustomFieldActionResult | null,
  formData: FormData,
): Promise<CustomFieldActionResult> {
  try {
    const fieldId = String(formData.get("fieldId") ?? "");
    const updated = await updateCustomFieldForCurrentUser(fieldId, fieldInput(formData));
    if (!updated) return { ok: false, error: "notFound" };

    revalidateVehicleViews();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorCode(error) };
  }
}

export async function deleteCustomFieldAction(
  _prev: CustomFieldActionResult | null,
  formData: FormData,
): Promise<CustomFieldActionResult> {
  try {
    const fieldId = String(formData.get("fieldId") ?? "");
    const deleted = await deleteCustomFieldForCurrentUser(fieldId);
    if (!deleted) return { ok: false, error: "notFound" };

    revalidateVehicleViews();
    return { ok: true };
  } catch {
    return { ok: false, error: "failed" };
  }
}
