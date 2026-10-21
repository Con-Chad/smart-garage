import { listRoute } from "@/lib/api/v1/collection";
import { createSchedule } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("schedules");
export const POST = createSchedule;
