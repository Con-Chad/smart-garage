import { itemRoute } from "@/lib/api/v1/collection";
import { deleteInspection } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("inspections");
export const DELETE = deleteInspection;
