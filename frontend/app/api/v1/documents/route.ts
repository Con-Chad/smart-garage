import { listRoute } from "@/lib/api/v1/collection";
import { createDocument } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("documents");
export const POST = createDocument;
