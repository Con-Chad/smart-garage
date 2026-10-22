import { FailureRateLimiter } from "@/lib/auth/rate-limit";
import { apiError, apiJson } from "@/lib/api/v1/http";
import { pushSubscriptionSchema } from "@/lib/api/v1/schemas";
import { ApiProblem, handleWrite, noContent, parseJsonBody, type WriteContext } from "@/lib/api/v1/write";
import { validatePushEndpoint } from "@/lib/notifications/push/endpoint-guard";
import { sendPushToDevice } from "@/lib/notifications/push/channel";
import { validateSubscriptionKeys } from "@/lib/notifications/push/web-push";
import {
  clearDevicePushSubscription,
  findActiveDeviceOwner,
  findDevicePushSubscription,
  setDevicePushSubscription,
  type DevicePushSubscription,
} from "@/lib/repositories/api-devices";
import { findPreferencesForUser } from "@/lib/repositories/preferences";

/**
 * Push subscription endpoints (D-037). A device token is required (D-034)
 * and a device may only manage its own subscription: another user's device
 * is a 404 (D-030: hidden), the caller's other device a 403 (visible in
 * `GET /devices`, but not theirs to change from here).
 */

type DeviceContext = { params: Promise<{ deviceId: string }> };

/** A user may trigger at most this many test pushes per device per window. */
const TEST_PUSH_LIMIT = 3;
const TEST_PUSH_WINDOW_MS = 15 * 60 * 1000;
// The limiter counts "failures"; here every attempt is recorded, so it is a plain attempt counter.
const testPushThrottle = new FailureRateLimiter(TEST_PUSH_LIMIT, TEST_PUSH_WINDOW_MS);

export function resetPushTestThrottleForTests(): void {
  testPushThrottle.clearAll();
}

async function assertOwnDevice(ctx: WriteContext, deviceId: string): Promise<void> {
  if (deviceId === ctx.device.id) return;
  const owner = await findActiveDeviceOwner(deviceId);
  if (!owner || owner.userId !== ctx.user.id) throw new ApiProblem(404, "not_found", "Not found");
  throw new ApiProblem(403, "forbidden", "A device can only manage its own push subscription");
}

function subscriptionToApi(subscription: DevicePushSubscription) {
  return {
    deviceId: subscription.deviceId,
    endpoint: subscription.endpoint,
    createdAt: subscription.createdAt,
    failedAt: subscription.failedAt,
    failureCount: subscription.failureCount,
  };
}

function withDeviceId(run: (ctx: WriteContext, deviceId: string) => Promise<Response>) {
  return async (request: Request, context: DeviceContext) => {
    const { deviceId } = await context.params;
    return handleWrite(request, (ctx) => run(ctx, deviceId));
  };
}

export const putDevicePush = withDeviceId(async (ctx, deviceId) => {
  await assertOwnDevice(ctx, deviceId);
  const body = await parseJsonBody(ctx.request, pushSubscriptionSchema);

  const endpoint = await validatePushEndpoint(body.endpoint);
  if (!endpoint.ok) {
    throw new ApiProblem(422, "endpoint_rejected", `Push endpoint rejected: ${endpoint.reason}`);
  }
  const keys = validateSubscriptionKeys(body.keys);
  if (!keys.ok) throw new ApiProblem(422, "validation_failed", `Push keys rejected: ${keys.reason}`);

  const subscription = await setDevicePushSubscription(deviceId, {
    endpoint: endpoint.url.toString(),
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
  });
  return apiJson({ push: subscriptionToApi(subscription) });
});

export const deleteDevicePush = withDeviceId(async (ctx, deviceId) => {
  await assertOwnDevice(ctx, deviceId);
  await clearDevicePushSubscription(deviceId);
  return noContent();
});

export const testDevicePush = withDeviceId(async (ctx, deviceId) => {
  await assertOwnDevice(ctx, deviceId);
  const subscription = await findDevicePushSubscription(deviceId);
  if (!subscription) {
    throw new ApiProblem(409, "push_not_registered", "This device has no push subscription");
  }

  const decision = testPushThrottle.check(deviceId);
  if (!decision.allowed) {
    return apiError(429, "rate_limited", "Too many test pushes; try again later", {
      headers: { "retry-after": String(decision.retryAfterSeconds) },
    });
  }
  testPushThrottle.recordFailure(deviceId);

  const locale = (await findPreferencesForUser(ctx.user.id)).locale;
  const result = await sendPushToDevice(
    subscription,
    {
      type: "test",
      title: locale === "de" ? "Smart Garage Test" : "Smart Garage test",
      body: locale === "de" ? "Push-Benachrichtigungen funktionieren." : "Push notifications are working.",
      url: "/",
    },
    { ignoreBackoff: true, ttl: 60 },
  );

  if (!result.ok) {
    return apiJson(
      { error: { code: result.dropped ? "push_subscription_gone" : "push_failed", message: result.error } },
      { status: 502 },
    );
  }
  return apiJson({ ok: true, deviceId });
});
