import { itemRoute } from "@/lib/api/v1/collection";
import { deleteOdometerLog } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("odometerLogs");
export const DELETE = deleteOdometerLog;
