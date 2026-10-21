import { WishlistCategory, WishlistStatus } from "@prisma/client";
import { z } from "zod";

const centsSchema = z.number({ error: "amountInvalid" }).int("amountInvalid").min(0, "amountInvalid");

/** A wishlist item in canonical form (amounts in integer cents). */
export const wishlistItemInputSchema = z.object({
  title: z.string({ error: "titleRequired" }).trim().min(1, "titleRequired").max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.nativeEnum(WishlistCategory).optional(),
  status: z.nativeEnum(WishlistStatus).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  targetDate: z.coerce.date({ error: "dateInvalid" }).nullable().optional(),
  url: z.string().trim().max(500).nullable().optional(),
  estimatedCostCents: centsSchema.nullable().optional(),
  currency: z.string().length(3).optional(),
  vehicleId: z.string().min(1).nullable().optional(),
  plannedMake: z.string().trim().max(80).nullable().optional(),
  plannedModel: z.string().trim().max(80).nullable().optional(),
  plannedYear: z.number({ error: "yearInvalid" }).int("yearInvalid").min(1900, "yearInvalid").max(2100, "yearInvalid").nullable().optional(),
  plannedBudgetCents: centsSchema.nullable().optional(),
});

export const wishlistItemPatchSchema = wishlistItemInputSchema.partial();

export type WishlistItemInputData = z.infer<typeof wishlistItemInputSchema>;
export type WishlistItemPatchData = z.infer<typeof wishlistItemPatchSchema>;
