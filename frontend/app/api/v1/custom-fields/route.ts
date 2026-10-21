import { listRoute } from "@/lib/api/v1/collection";
import { createCustomField } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("customFields");
export const POST = createCustomField;
