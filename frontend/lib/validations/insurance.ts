import { InsuranceCoverageType } from "@prisma/client";
import { z } from "zod";

/** An insurance policy in canonical form (premium in integer cents). */
export const insurancePolicyInputSchema = z.object({
  provider: z.string({ error: "providerRequired" }).trim().min(1, "providerRequired").max(120),
  policyNumber: z.string().trim().max(80).nullable().optional(),
  premiumCents: z.number({ error: "premiumInvalid" }).int("premiumInvalid").min(0, "premiumInvalid"),
  currency: z.string().length(3).optional(),
  sfClass: z.string().trim().max(20).nullable().optional(),
  coverageType: z.nativeEnum(InsuranceCoverageType).default("LIABILITY"),
  startDate: z.coerce.date({ error: "dateInvalid" }),
  endDate: z.coerce.date({ error: "dateInvalid" }),
  autoRenew: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export type InsurancePolicyInputData = z.infer<typeof insurancePolicyInputSchema>;
