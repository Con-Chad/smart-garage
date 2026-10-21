import { listRoute } from "@/lib/api/v1/collection";
import { createModification } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("modifications");
export const POST = createModification;
