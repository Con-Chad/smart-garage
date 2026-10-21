"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { WishlistStatus } from "@prisma/client";
import {
  createWishlistItemForCurrentUser,
  deleteWishlistItemForCurrentUser,
  updateWishlistItemForCurrentUser,
} from "@/lib/services/wishlist";

function eurosToCents(raw: string): number | null {
  return raw ? Math.round(Number(raw) * 100) : null;
}

export async function createWishlistAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await createWishlistItemForCurrentUser({
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? "") || null,
      category: String(formData.get("category") ?? "OTHER"),
      status: String(formData.get("status") ?? "IDEA"),
      url: String(formData.get("url") ?? "") || null,
      plannedMake: String(formData.get("plannedMake") ?? "") || null,
      plannedModel: String(formData.get("plannedModel") ?? "") || null,
      plannedYear: formData.get("plannedYear") ? Number(formData.get("plannedYear")) : null,
      estimatedCostCents: eurosToCents(String(formData.get("estimatedCostEuros") ?? "")),
      plannedBudgetCents: eurosToCents(String(formData.get("plannedBudgetEuros") ?? "")),
      targetDate: formData.get("targetDate") ? String(formData.get("targetDate")) : null,
    });

    revalidatePath("/wishlist");
    return { ok: true };
  } catch (error) {
    if (error instanceof ZodError && error.issues[0]?.message === "titleRequired") {
      return { ok: false, error: "titleRequired" };
    }
    return { ok: false, error: "unknown" };
  }
}

export async function updateWishlistStatusAction(
  id: string,
  status: WishlistStatus,
): Promise<{ ok: boolean }> {
  await updateWishlistItemForCurrentUser(id, { status });
  revalidatePath("/wishlist");
  return { ok: true };
}

export async function deleteWishlistAction(id: string): Promise<{ ok: boolean }> {
  await deleteWishlistItemForCurrentUser(id);
  revalidatePath("/wishlist");
  return { ok: true };
}
