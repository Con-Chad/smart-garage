import { API_VERSION, apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { findPreferencesForUser } from "@/lib/repositories/preferences";
import { APP_VERSION } from "@/lib/app-version";

export const dynamic = "force-dynamic";

/**
 * The signed-in user plus their display preferences. All API values are in
 * stored units (km, liters, cents); `preferences.distanceUnit`/`volumeUnit`/
 * `currency` say how the app should display them.
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const preferences = await findPreferencesForUser(auth.user.id);

  return apiJson({
    user: {
      id: auth.user.id,
      username: auth.user.username,
      displayName: auth.user.displayName,
      role: auth.user.role,
    },
    device: auth.device ? { id: auth.device.id, name: auth.device.name } : null,
    preferences: {
      locale: preferences.locale,
      timezone: preferences.timezone,
      currency: preferences.currency,
      distanceUnit: preferences.distanceUnit,
      volumeUnit: preferences.volumeUnit,
      maintenanceDueSoonKm: preferences.maintenanceDueSoonKm,
      maintenanceDueSoonDays: preferences.maintenanceDueSoonDays,
      hiddenVehicleFields: preferences.hiddenVehicleFields,
    },
    units: { distance: "km", volume: "l", money: "cents" },
    server: { version: APP_VERSION, apiVersion: API_VERSION },
  });
}
