import { listRoute } from "@/lib/api/v1/collection";
import { createOdometerLog } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("odometerLogs");
export const POST = createOdometerLog;
