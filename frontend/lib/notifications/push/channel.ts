import { validatePushEndpoint } from "@/lib/notifications/push/endpoint-guard";
import { getOrCreateVapidKeys, vapidSubject } from "@/lib/notifications/push/vapid";
import { sendWebPush, type WebPushOptions } from "@/lib/notifications/push/web-push";
import {
  clearDevicePushSubscription,
  listPushSubscriptionsForUser,
  recordPushDelivery,
  recordPushFailure,
  type DevicePushSubscription,
} from "@/lib/repositories/api-devices";

/**
 * The "Mobile app (UnifiedPush)" channel: one encrypted Web Push per
 * subscribed device of the user. Sits next to Pushover and Telegram inside
 * `dispatchToEnabledChannels`, so it inherits the same events, thresholds,
 * delivery windows, quiet hours and minimum interval.
 *
 * Cleanup (D-022/D-039): 404 and 410 mean the subscription is gone and it is
 * removed at once. ntfy answers 507 for a topic nobody subscribes to; that
 * and any other failure count towards a backoff, and a 507 on the third
 * consecutive failure removes the subscription too.
 */

export type PushNotificationType =
  | "maintenance_due"
  | "odometer_reminder"
  | "maintenance_logged"
  | "expense_added"
  | "test";

/** What the phone receives (after decryption): nothing beyond the notification text. */
export type PushPayload = {
  type: PushNotificationType;
  title: string;
  body: string;
  vehicleId?: string;
  scheduleId?: string;
  /** Path inside the web app / the app's matching screen, e.g. `/maintenance`. */
  url: string;
};

export type PushChannelResult = {
  /** Devices that accepted the message. */
  sent: number;
  /** Devices skipped because of a recent failure. */
  skipped: number;
  /** Subscriptions removed because the push service said they are gone. */
  dropped: number;
  errors: string[];
};

const MAX_FAILURES_BEFORE_507_DROP = 3;
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** How long to leave a failing subscription alone: 15 min, 30 min, 1 h … capped at a day. */
export function backoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failureCount - 1), BACKOFF_MAX_MS);
}

export function isBackingOff(subscription: Pick<DevicePushSubscription, "failedAt" | "failureCount">, now = Date.now()): boolean {
  if (!subscription.failedAt || subscription.failureCount <= 0) return false;
  return now - subscription.failedAt.getTime() < backoffMs(subscription.failureCount);
}

export function serializePushPayload(payload: PushPayload): string {
  const compact: PushPayload = { type: payload.type, title: payload.title, body: payload.body, url: payload.url };
  if (payload.vehicleId) compact.vehicleId = payload.vehicleId;
  if (payload.scheduleId) compact.scheduleId = payload.scheduleId;
  return JSON.stringify(compact);
}

export type SendPushOptions = Pick<WebPushOptions, "ttl" | "urgency" | "fetchImpl"> & {
  /** Send even while the device is backing off (the user-triggered test push). */
  ignoreBackoff?: boolean;
};

/** Sends one message to one device and applies the cleanup rules. */
export async function sendPushToDevice(
  subscription: DevicePushSubscription,
  payload: PushPayload,
  options: SendPushOptions = {},
): Promise<{ ok: true } | { ok: false; error: string; dropped: boolean; status: number | null }> {
  // Re-check at send time so a host that was public when registered can't
  // be re-pointed (DNS rebinding) at something internal later.
  const endpoint = await validatePushEndpoint(subscription.endpoint);
  if (!endpoint.ok) {
    await clearDevicePushSubscription(subscription.deviceId);
    return { ok: false, error: `endpoint rejected: ${endpoint.reason}`, dropped: true, status: null };
  }

  const keys = await getOrCreateVapidKeys();
  const result = await sendWebPush(subscription, serializePushPayload(payload), { keys, subject: vapidSubject() }, options);

  if (result.ok) {
    await recordPushDelivery(subscription.deviceId);
    return { ok: true };
  }

  if (result.gone) {
    await clearDevicePushSubscription(subscription.deviceId);
    return { ok: false, error: result.error, dropped: true, status: result.status };
  }

  const failures = await recordPushFailure(subscription.deviceId);
  if (result.status === 507 && failures >= MAX_FAILURES_BEFORE_507_DROP) {
    await clearDevicePushSubscription(subscription.deviceId);
    return { ok: false, error: `${result.error} (no subscriber, removed)`, dropped: true, status: result.status };
  }
  return { ok: false, error: result.error, dropped: false, status: result.status };
}

/** Sends to every subscribed, active device of the user. */
export async function sendPushToUserDevices(
  userId: string,
  payload: PushPayload,
  options: SendPushOptions = {},
): Promise<PushChannelResult> {
  const subscriptions = await listPushSubscriptionsForUser(userId);
  const result: PushChannelResult = { sent: 0, skipped: 0, dropped: 0, errors: [] };

  await Promise.all(
    subscriptions.map(async (subscription) => {
      if (!options.ignoreBackoff && isBackingOff(subscription)) {
        result.skipped += 1;
        return;
      }
      const outcome = await sendPushToDevice(subscription, payload, options);
      if (outcome.ok) {
        result.sent += 1;
      } else {
        if (outcome.dropped) result.dropped += 1;
        result.errors.push(outcome.error);
      }
    }),
  );

  return result;
}
