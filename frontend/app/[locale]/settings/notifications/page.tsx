import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/layout/PageHeader";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { getCurrentUserId } from "@/lib/auth/current-user";
import { countPushSubscriptionsForUser } from "@/lib/repositories/api-devices";
import { getNotificationSettingsForCurrentUser } from "@/lib/services/notifications";

type Props = { params: Promise<{ locale: string }> };

export default async function NotificationSettingsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("pages.settings.notifications");
  const [notificationSettings, pushDeviceCount] = await Promise.all([
    getNotificationSettingsForCurrentUser(),
    getCurrentUserId().then(countPushSubscriptionsForUser),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("description")} />
      <NotificationSettings initial={notificationSettings} pushDeviceCount={pushDeviceCount} />
    </div>
  );
}
