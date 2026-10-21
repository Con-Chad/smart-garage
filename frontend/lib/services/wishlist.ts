import { getCurrentUserId } from "@/lib/auth/current-user";
import { prisma } from "@/lib/prisma";
import { vehicleAccessWhere } from "@/lib/vehicles/access";
import {
  createWishlistItem,
  deleteWishlistItem,
  updateWishlistItem,
  type WishlistItemInput,
} from "@/lib/repositories/wishlist";
import {
  wishlistItemInputSchema,
  wishlistItemPatchSchema,
  type WishlistItemPatchData,
} from "@/lib/validations/wishlist";

function toRepositoryInput(data: WishlistItemPatchData): Partial<WishlistItemInput> {
  const { estimatedCostCents, plannedBudgetCents, ...rest } = data;
  return {
    ...rest,
    ...(estimatedCostCents !== undefined
      ? { estimatedCostCents: estimatedCostCents == null ? null : BigInt(estimatedCostCents) }
      : {}),
    ...(plannedBudgetCents !== undefined
      ? { plannedBudgetCents: plannedBudgetCents == null ? null : BigInt(plannedBudgetCents) }
      : {}),
  };
}

/** A wishlist item may point at any vehicle the user can see. */
async function assertLinkableVehicle(userId: string, vehicleId: string | null | undefined) {
  if (!vehicleId) return;
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, ...vehicleAccessWhere(userId) },
    select: { id: true },
  });
  if (!vehicle) throw new Error("VEHICLE_NOT_FOUND");
}

export async function createWishlistItemForCurrentUser(input: unknown) {
  const data = wishlistItemInputSchema.parse(input);
  const userId = await getCurrentUserId();
  await assertLinkableVehicle(userId, data.vehicleId);
  return createWishlistItem(userId, toRepositoryInput(data) as WishlistItemInput);
}

/** Partial update of one of the user's items. Returns false when it isn't theirs. */
export async function updateWishlistItemForCurrentUser(itemId: string, input: unknown) {
  const data = wishlistItemPatchSchema.parse(input);
  const userId = await getCurrentUserId();
  await assertLinkableVehicle(userId, data.vehicleId);
  const result = await updateWishlistItem(itemId, userId, toRepositoryInput(data));
  return result.count > 0;
}

export async function deleteWishlistItemForCurrentUser(itemId: string) {
  const userId = await getCurrentUserId();
  const result = await deleteWishlistItem(itemId, userId);
  return result.count > 0;
}
