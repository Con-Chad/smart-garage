import { apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { findNotificationSettings } from "@/lib/repositories/notifications";
import { notificationSettingsToApi } from "@/lib/api/v1/settings";

export const dynamic = "force-dynamic";

/** Notification preferences; Pushover/Telegram credentials are never returned. */
export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;
  return apiJson(notificationSettingsToApi(await findNotificationSettings(auth.user.id)));
}
