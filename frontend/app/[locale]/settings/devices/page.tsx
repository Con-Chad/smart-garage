import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/layout/PageHeader";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/Button";
import { getCurrentUserId } from "@/lib/auth/current-user";
import { listApiDevicesForUser } from "@/lib/repositories/api-devices";
import { findPreferencesForUser } from "@/lib/repositories/preferences";
import { revokeApiDeviceAction } from "@/lib/actions/api-devices";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export default async function DevicesSettingsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("pages.settings.devices");
  const userId = await getCurrentUserId();
  const [devices, preferences] = await Promise.all([
    listApiDevicesForUser(userId),
    findPreferencesForUser(userId),
  ]);

  const formatDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: preferences.timezone,
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("description")} />
      <SettingsSection title={t("listTitle")} description={t("listDescription")}>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium text-foreground">
                    {device.name}
                    {device.revokedAt ? (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        {t("revokedBadge")}
                      </span>
                    ) : device.pushSubscribed ? (
                      <span
                        className="ml-2 rounded bg-success/10 px-1.5 py-0.5 text-xs font-normal text-success"
                        title={device.pushFailedAt ? t("pushFailing") : undefined}
                      >
                        {device.pushFailedAt ? t("pushFailingBadge") : t("pushOnBadge")}
                      </span>
                    ) : (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        {t("pushOffBadge")}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <code>{device.tokenPrefix}…</code>
                    {" · "}
                    {t("created", { date: formatDate.format(device.createdAt) })}
                    {" · "}
                    {device.revokedAt
                      ? t("revokedAt", { date: formatDate.format(device.revokedAt) })
                      : device.lastUsedAt
                        ? t("lastUsed", { date: formatDate.format(device.lastUsedAt) })
                        : t("neverUsed")}
                  </p>
                </div>
                {device.revokedAt ? null : (
                  <form action={revokeApiDeviceAction}>
                    <input type="hidden" name="deviceId" value={device.id} />
                    <Button type="submit" variant="danger">
                      {t("revoke")}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
