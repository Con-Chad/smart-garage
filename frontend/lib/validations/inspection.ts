import { InspectionType } from "@prisma/client";
import { z } from "zod";

/** An inspection (HU/AU) in canonical form; shared by the web action and the API. */
export const inspectionInputSchema = z.object({
  type: z.nativeEnum(InspectionType, { error: "invalidType" }),
  nextDueAt: z.coerce.date({ error: "invalidDate" }),
  lastPerformedAt: z.coerce.date({ error: "invalidDate" }).nullable().optional(),
  reminderWeeksBefore: z.number().int().min(0).max(52).optional(),
  stickerNumber: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export type InspectionInputData = z.infer<typeof inspectionInputSchema>;
