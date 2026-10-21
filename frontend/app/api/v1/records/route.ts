import { listRoute } from "@/lib/api/v1/collection";
import { createRecord } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("maintenanceRecords");
export const POST = createRecord;
