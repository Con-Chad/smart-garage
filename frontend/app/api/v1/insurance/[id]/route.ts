import { itemRoute } from "@/lib/api/v1/collection";
import { updateInsurance, deleteInsurance } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("insurancePolicies");
export const PATCH = updateInsurance;
export const DELETE = deleteInsurance;
