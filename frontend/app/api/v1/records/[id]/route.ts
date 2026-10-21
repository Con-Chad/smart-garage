import { itemRoute } from "@/lib/api/v1/collection";
import { updateRecord, deleteRecord } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("maintenanceRecords");
export const PATCH = updateRecord;
export const DELETE = deleteRecord;
