import { getCurrentUserId } from "@/lib/auth/current-user";
import {
  createInsurancePolicy,
  deleteInsurancePolicy,
  updateInsurancePolicy,
  type InsurancePolicyInput,
} from "@/lib/repositories/insurance";
import { insurancePolicyInputSchema } from "@/lib/validations/insurance";

function toRepositoryInput(input: unknown): InsurancePolicyInput {
  const data = insurancePolicyInputSchema.parse(input);
  return { ...data, premiumCents: BigInt(data.premiumCents) };
}

/** Throws ZodError on invalid input; returns null when the user may not edit the vehicle. */
export async function createInsurancePolicyForCurrentUser(vehicleId: string, input: unknown) {
  const data = toRepositoryInput(input);
  const userId = await getCurrentUserId();
  return createInsurancePolicy(vehicleId, userId, data);
}

/** Replaces a policy. Returns null when it doesn't exist or the user may not edit it. */
export async function updateInsurancePolicyForCurrentUser(policyId: string, input: unknown) {
  const data = toRepositoryInput(input);
  const userId = await getCurrentUserId();
  return updateInsurancePolicy(policyId, userId, data);
}

export async function deleteInsurancePolicyForCurrentUser(policyId: string): Promise<boolean> {
  const userId = await getCurrentUserId();
  const result = await deleteInsurancePolicy(policyId, userId);
  return result.count > 0;
}
