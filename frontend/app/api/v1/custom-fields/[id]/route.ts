import { itemRoute } from "@/lib/api/v1/collection";
import { updateCustomField, deleteCustomField } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("customFields");
export const PATCH = updateCustomField;
export const DELETE = deleteCustomField;
