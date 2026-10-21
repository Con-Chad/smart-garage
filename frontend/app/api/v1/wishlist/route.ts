import { listRoute } from "@/lib/api/v1/collection";
import { createWishlistItem } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("wishlistItems");
export const POST = createWishlistItem;
