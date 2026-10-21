import type { UserSettings } from "@/lib/settings/types";
import type { NotificationSettingsRecord } from "@/lib/repositories/notifications";

/** Display preferences as the app needs them; stored values stay metric. */
export function preferencesToApi(preferences: UserSettings) {
  return {
    locale: preferences.locale,
    timezone: preferences.timezone,
    currency: preferences.currency,
    distanceUnit: preferences.distanceUnit,
    volumeUnit: preferences.volumeUnit,
    maintenanceDueSoonKm: preferences.maintenanceDueSoonKm,
    maintenanceDueSoonDays: preferences.maintenanceDueSoonDays,
    hiddenVehicleFields: preferences.hiddenVehicleFields,
    quickFuelEnabled: preferences.quickFuelEnabled,
  };
}

/**
 * Notification settings without the Pushover/Telegram credentials: the app
 * only needs to know whether a channel is set up, and a lost phone shouldn't
 * leak bot tokens.
 */
export function notificationSettingsToApi(settings: NotificationSettingsRecord | null) {
  if (!settings) return null;
  const {
    pushoverUserKey,
    pushoverAppToken,
    telegramBotToken,
    telegramChatId,
    ...rest
  } = settings;
  return {
    ...rest,
    pushoverConfigured: Boolean(pushoverUserKey && pushoverAppToken),
    telegramConfigured: Boolean(telegramBotToken && telegramChatId),
  };
}
