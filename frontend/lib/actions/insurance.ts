"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  createInsurancePolicyForCurrentUser,
  deleteInsurancePolicyForCurrentUser,
  updateInsurancePolicyForCurrentUser,
} from "@/lib/services/insurance";

/** Error codes the insurance form has messages for. */
const FORM_ERRORS = new Set(["providerRequired", "premiumInvalid", "dateInvalid"]);

export async function saveInsuranceAction(
  vehicleId: string,
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const premiumEuros = Number(formData.get("premiumEuros"));
    if (Number.isNaN(premiumEuros) || premiumEuros < 0) {
      return { ok: false, error: "premiumInvalid" };
    }

    const policyId = String(formData.get("policyId") ?? "");
    const payload = {
      provider: String(formData.get("provider") ?? ""),
      policyNumber: String(formData.get("policyNumber") ?? "") || null,
      premiumCents: Math.round(premiumEuros * 100),
      sfClass: String(formData.get("sfClass") ?? "") || null,
      coverageType: String(formData.get("coverageType") ?? "LIABILITY"),
      startDate: String(formData.get("startDate") ?? ""),
      endDate: String(formData.get("endDate") ?? ""),
      autoRenew: formData.get("autoRenew") === "on",
      notes: String(formData.get("notes") ?? "") || null,
    };

    const result = policyId
      ? await updateInsurancePolicyForCurrentUser(policyId, payload)
      : await createInsurancePolicyForCurrentUser(vehicleId, payload);

    if (!result) return { ok: false, error: "notAllowed" };

    revalidatePath(`/vehicles/${vehicleId}`);
    revalidatePath("/costs");
    return { ok: true };
  } catch (error) {
    const code = error instanceof ZodError ? error.issues[0]?.message : undefined;
    return { ok: false, error: code && FORM_ERRORS.has(code) ? code : "unknown" };
  }
}

export async function deleteInsuranceFormAction(formData: FormData) {
  const policyId = String(formData.get("policyId") ?? "");
  const vehicleId = String(formData.get("vehicleId") ?? "");
  await deleteInsurancePolicyForCurrentUser(policyId);
  revalidatePath(`/vehicles/${vehicleId}`);
}
