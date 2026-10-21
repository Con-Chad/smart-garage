import { itemRoute } from "@/lib/api/v1/collection";
import { updateSchedule, deleteSchedule } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("schedules");
export const PATCH = updateSchedule;
export const DELETE = deleteSchedule;
