import { listRoute } from "@/lib/api/v1/collection";
import { saveInspection } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("inspections");
export const POST = saveInspection;
