import { itemRoute } from "@/lib/api/v1/collection";
import { deleteDocument } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("documents");
export const DELETE = deleteDocument;
