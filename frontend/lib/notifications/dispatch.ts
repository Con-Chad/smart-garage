import { sendPushoverNotification } from "@/lib/notifications/pushover";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { sendPushToUserDevices, type PushNotificationType } from "@/lib/notifications/push/channel";
import type { NotificationSettingsRecord } from "@/lib/repositories/notifications";

export type NotificationChannel = "pushover" | "telegram" | "push";

export type NotificationPayload = {
  title: string;
  message: string;
  telegramHtml?: string;
  priority?: -2 | -1 | 0 | 1 | 2;
  /**
   * What the mobile app gets, besides `title` and `message`: an event type
   * and a path to open. Defaults to a generic alert opening the dashboard.
   */
  push?: { type: PushNotificationType; url: string; vehicleId?: string; scheduleId?: string };
};

export type DispatchResult = {
  sentChannels: NotificationChannel[];
  errors: string[];
};

function pushoverReady(settings: NotificationSettingsRecord) {
  return Boolean(settings.pushoverEnabled && settings.pushoverUserKey && settings.pushoverAppToken);
}

function telegramReady(settings: NotificationSettingsRecord) {
  return Boolean(settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId);
}

/** The mobile channel counts as enabled only while a device can actually receive it. */
export function mobilePushReady(settings: Pick<NotificationSettingsRecord, "mobilePushEnabled" | "mobilePushDevices">) {
  return settings.mobilePushEnabled && settings.mobilePushDevices > 0;
}

export function getEnabledChannels(settings: NotificationSettingsRecord) {
  const channels: NotificationChannel[] = [];
  if (pushoverReady(settings)) channels.push("pushover");
  if (telegramReady(settings)) channels.push("telegram");
  if (mobilePushReady(settings)) channels.push("push");
  return channels;
}

export async function dispatchToEnabledChannels(
  settings: NotificationSettingsRecord,
  payload: NotificationPayload,
): Promise<DispatchResult> {
  const sentChannels: NotificationChannel[] = [];
  const errors: string[] = [];

  const tasks: Promise<void>[] = [];

  if (pushoverReady(settings)) {
    tasks.push(
      sendPushoverNotification({
        userKey: settings.pushoverUserKey!,
        appToken: settings.pushoverAppToken!,
        title: payload.title,
        message: payload.message,
        priority: payload.priority,
      }).then((result) => {
        if (result.ok) {
          sentChannels.push("pushover");
        } else {
          errors.push(`Pushover: ${result.error}`);
        }
      }),
    );
  }

  if (telegramReady(settings)) {
    tasks.push(
      sendTelegramNotification({
        botToken: settings.telegramBotToken!,
        chatId: settings.telegramChatId!,
        text: payload.telegramHtml ?? payload.message,
      }).then((result) => {
        if (result.ok) {
          sentChannels.push("telegram");
        } else {
          errors.push(`Telegram: ${result.error}`);
        }
      }),
    );
  }

  if (mobilePushReady(settings)) {
    const push = payload.push ?? { type: "maintenance_due" as const, url: "/" };
    tasks.push(
      sendPushToUserDevices(
        settings.userId,
        {
          type: push.type,
          title: payload.title,
          body: payload.message,
          url: push.url,
          vehicleId: push.vehicleId,
          scheduleId: push.scheduleId,
        },
        { urgency: (payload.priority ?? 0) >= 1 ? "high" : "normal" },
      ).then((result) => {
        if (result.sent > 0) {
          sentChannels.push("push");
        }
        for (const error of result.errors) errors.push(`Push: ${error}`);
        if (result.sent === 0 && result.errors.length === 0 && result.skipped > 0) {
          errors.push("Push: every device is backing off after recent failures");
        }
      }),
    );
  }

  await Promise.all(tasks);

  return { sentChannels, errors };
}
