import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db/retry";
import { getEnabledChannels } from "@/lib/notifications/dispatch";

export type NotificationSettingsRecord = {
  userId: string;
  pushoverEnabled: boolean;
  pushoverUserKey: string | null;
  pushoverAppToken: string | null;
  telegramEnabled: boolean;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /** Web Push to the mobile app (UnifiedPush). Delivers only when `mobilePushDevices > 0`. */
  mobilePushEnabled: boolean;
  /** Active devices with a push subscription; derived, never written. */
  mobilePushDevices: number;
  eventMaintenanceOverdue: boolean;
  eventMaintenanceDueSoon: boolean;
  eventMaintenanceLogged: boolean;
  eventExpenseAdded: boolean;
  eventOdometerReminder: boolean;
  odometerReminderDays: number;
  deliveryImmediate: boolean;
  deliveryScheduled: boolean;
  scheduledTime: string | null;
  scheduledDays: string | null;
  minIntervalHours: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  lastMaintenanceAlertAt: Date | null;
  lastOdometerReminderAt: Date | null;
};

/** Data the settings page and API write; `userId` and the device count are not theirs to set. */
export type NotificationSettingsData = Omit<
  NotificationSettingsRecord,
  "userId" | "mobilePushDevices" | "lastMaintenanceAlertAt" | "lastOdometerReminderAt"
>;

const selectFields = {
  userId: true,
  pushoverEnabled: true,
  pushoverUserKey: true,
  pushoverAppToken: true,
  telegramEnabled: true,
  telegramBotToken: true,
  telegramChatId: true,
  mobilePushEnabled: true,
  eventMaintenanceOverdue: true,
  eventMaintenanceDueSoon: true,
  eventMaintenanceLogged: true,
  eventExpenseAdded: true,
  eventOdometerReminder: true,
  odometerReminderDays: true,
  deliveryImmediate: true,
  deliveryScheduled: true,
  scheduledTime: true,
  scheduledDays: true,
  minIntervalHours: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  timezone: true,
  lastMaintenanceAlertAt: true,
  lastOdometerReminderAt: true,
} as const;

/** Active devices with a push subscription, counted alongside the settings row. */
const pushDeviceCountSelect = {
  _count: {
    select: {
      apiDevices: { where: { revokedAt: null, pushEndpoint: { not: null } } },
    },
  },
} as const;

type SettingsRow = {
  [K in keyof typeof selectFields]: K extends keyof NotificationSettingsRecord
    ? NotificationSettingsRecord[K]
    : never;
};

function toRecord(
  row: SettingsRow,
  user: { _count: { apiDevices: number } } | null,
): NotificationSettingsRecord {
  return {
    userId: row.userId,
    pushoverEnabled: row.pushoverEnabled,
    pushoverUserKey: row.pushoverUserKey,
    pushoverAppToken: row.pushoverAppToken,
    telegramEnabled: row.telegramEnabled,
    telegramBotToken: row.telegramBotToken,
    telegramChatId: row.telegramChatId,
    mobilePushEnabled: row.mobilePushEnabled,
    mobilePushDevices: user?._count.apiDevices ?? 0,
    eventMaintenanceOverdue: row.eventMaintenanceOverdue,
    eventMaintenanceDueSoon: row.eventMaintenanceDueSoon,
    eventMaintenanceLogged: row.eventMaintenanceLogged,
    eventExpenseAdded: row.eventExpenseAdded,
    eventOdometerReminder: row.eventOdometerReminder,
    odometerReminderDays: row.odometerReminderDays,
    deliveryImmediate: row.deliveryImmediate,
    deliveryScheduled: row.deliveryScheduled,
    scheduledTime: row.scheduledTime,
    scheduledDays: row.scheduledDays,
    minIntervalHours: row.minIntervalHours,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    timezone: row.timezone,
    lastMaintenanceAlertAt: row.lastMaintenanceAlertAt,
    lastOdometerReminderAt: row.lastOdometerReminderAt,
  };
}

export async function findNotificationSettings(
  userId: string,
): Promise<NotificationSettingsRecord | null> {
  const row = await prisma.userNotificationSettings.findUnique({
    where: { userId },
    select: { ...selectFields, user: { select: pushDeviceCountSelect } },
  });
  return row ? toRecord(row, row.user) : null;
}

/**
 * Returns the userId + locale (via preferences) + notification settings for
 * every user that has notification settings with at least one channel enabled.
 * Used by the background scheduler to deliver alerts without a page request.
 */
export async function listUsersForNotificationScheduling(): Promise<
  Array<{
    userId: string;
    locale: "en" | "de";
    settings: NotificationSettingsRecord;
  }>
> {
  const rows = await prisma.userNotificationSettings.findMany({
    select: {
      ...selectFields,
      user: {
        select: {
          preferences: { select: { locale: true } },
          ...pushDeviceCountSelect,
        },
      },
    },
  });

  const result: Array<{
    userId: string;
    locale: "en" | "de";
    settings: NotificationSettingsRecord;
  }> = [];

  for (const row of rows) {
    const settings = toRecord(row, row.user);

    if (getEnabledChannels(settings).length === 0) continue;
    if (
      !settings.eventMaintenanceOverdue &&
      !settings.eventMaintenanceDueSoon &&
      !settings.eventOdometerReminder
    ) {
      continue;
    }

    const localeRaw = row.user?.preferences?.locale;
    const locale: "en" | "de" = localeRaw === "en" ? "en" : "de";
    result.push({ userId: row.userId, locale, settings });
  }

  return result;
}

export async function upsertNotificationSettings(
  userId: string,
  data: NotificationSettingsData,
) {
  return withDbRetry(() =>
    prisma.userNotificationSettings.upsert({
      where: { userId },
      create: {
        userId,
        ...data,
      },
      update: data,
    }),
  );
}

export async function touchMaintenanceAlertSent(userId: string) {
  return withDbRetry(() =>
    prisma.userNotificationSettings.update({
      where: { userId },
      data: { lastMaintenanceAlertAt: new Date() },
    }),
  );
}

export async function touchOdometerReminderSent(userId: string) {
  return withDbRetry(() =>
    prisma.userNotificationSettings.update({
      where: { userId },
      data: { lastOdometerReminderAt: new Date() },
    }),
  );
}
