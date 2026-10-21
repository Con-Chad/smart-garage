import { apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { getMaintenancePageData } from "@/lib/services/maintenance";
import { sortDueSchedules, sortSchedulesForSetup } from "@/lib/maintenance/reminder-queue";
import { listDueInspectionsForUser } from "@/lib/repositories/inspections";
import { listExpiringPolicies } from "@/lib/repositories/insurance";
import { findPreferencesForUser } from "@/lib/repositories/preferences";

export const dynamic = "force-dynamic";

/**
 * The Reminders page, computed by the server exactly as the web shows it:
 * due/overdue schedules (with fresh due status and names in the user's
 * locale), schedules that still need a first service date, inspections due
 * within 60 days and insurance policies ending within 45 days.
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const userId = auth.user.id;
  const { locale } = await findPreferencesForUser(userId);
  const [{ schedules }, inspections, policies] = await Promise.all([
    getMaintenancePageData(locale),
    listDueInspectionsForUser(userId, 60),
    listExpiringPolicies(userId, 45),
  ]);

  return apiJson({
    due: sortDueSchedules(schedules),
    needsSetup: sortSchedulesForSetup(schedules).map((schedule) => schedule.id),
    inspections: inspections.map(({ vehicle, ...inspection }) => ({
      ...inspection,
      vehicleName: vehicleLabel(vehicle),
    })),
    insurance: policies.map(({ vehicle, ...policy }) => ({
      ...policy,
      vehicleName: vehicleLabel(vehicle),
    })),
  });
}

function vehicleLabel(vehicle: { make: string | null; model: string | null; licensePlate: string | null }) {
  return [vehicle.make, vehicle.model].filter(Boolean).join(" ") || vehicle.licensePlate || null;
}
