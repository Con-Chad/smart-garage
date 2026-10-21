import { itemRoute } from "@/lib/api/v1/collection";
import { updateModification, deleteModification } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("modifications");
export const PATCH = updateModification;
export const DELETE = deleteModification;
