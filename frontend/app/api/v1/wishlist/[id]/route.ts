import { itemRoute } from "@/lib/api/v1/collection";
import { updateWishlistItem, deleteWishlistItem } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("wishlistItems");
export const PATCH = updateWishlistItem;
export const DELETE = deleteWishlistItem;
