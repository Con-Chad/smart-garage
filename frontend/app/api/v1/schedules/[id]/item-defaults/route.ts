import { putScheduleItemDefaults, deleteScheduleItemDefaults } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

/** The parts a schedule pre-fills when logging a service. */
export const PUT = putScheduleItemDefaults;
export const DELETE = deleteScheduleItemDefaults;
