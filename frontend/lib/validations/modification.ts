import { ModificationCategory } from "@prisma/client";
import { z } from "zod";

/** A vehicle modification in canonical form (cost in integer cents). */
export const modificationInputSchema = z.object({
  category: z.nativeEnum(ModificationCategory),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  installedAt: z.coerce.date().optional().nullable(),
  costCents: z.number().int().min(0).optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  addedPowerKw: z.number().int().optional().nullable(),
  addedPowerPs: z.number().int().optional().nullable(),
  addedTorqueNm: z.number().int().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  isCustom: z.boolean().optional(),
});

export type ModificationInputData = z.infer<typeof modificationInputSchema>;
