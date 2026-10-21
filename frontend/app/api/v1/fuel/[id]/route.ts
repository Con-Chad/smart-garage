import { itemRoute } from "@/lib/api/v1/collection";
import { deleteFuel } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("fuelEntries");
export const DELETE = deleteFuel;
