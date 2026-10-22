import { createECDH, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ headers: new Headers(), session: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) => (request.session ? { name, value: request.session } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

// No network in tests: "private.example" resolves to a LAN address, everything else is public.
vi.mock("node:dns", () => ({
  promises: {
    lookup: async (hostname: string) => [
      { address: hostname === "private.example" ? "10.0.0.7" : "104.16.1.1", family: 4 },
    ],
  },
}));

import { prisma } from "@/lib/prisma";
import { createApiDevice } from "@/lib/repositories/api-devices";
import { createSession } from "@/lib/auth/session";
import { resetPushTestThrottleForTests } from "@/lib/api/v1/push";
import { resetVapidKeyCacheForTests } from "@/lib/notifications/push/vapid";
import { maybeSendMaintenanceAlerts } from "@/lib/services/notifications";
import { getEnabledChannels } from "@/lib/notifications/dispatch";
import { findNotificationSettings } from "@/lib/repositories/notifications";
import { PUT as putPush, DELETE as deletePush } from "@/app/api/v1/devices/[deviceId]/push/route";
import { POST as testPush } from "@/app/api/v1/devices/[deviceId]/push/test/route";
import { GET as vapid } from "@/app/api/v1/push/vapid/route";
import { GET as listDevices } from "@/app/api/v1/devices/route";
import { GET as getNotifications, PATCH as patchNotifications } from "@/app/api/v1/notification-settings/route";
import { createUser, createVehicle } from "@/test/integration/factories";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const url = (p: string) => `http://test/api/v1/${p}`;
const params = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) });

function jsonRequest(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(url(p), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function useBearer(token: string | null) {
  request.headers = new Headers(token ? { authorization: `Bearer ${token}` } : {});
}

/** A subscription as the app would report it from its UnifiedPush distributor. */
function makeSubscription(endpoint = `https://ntfy.sh/up${randomBytes(6).toString("hex")}?up=1`) {
  const ecdh = createECDH("prime256v1");
  const p256dh = ecdh.generateKeys().toString("base64url");
  return { endpoint, keys: { p256dh, auth: randomBytes(16).toString("base64url") } };
}

async function pushState(deviceId: string) {
  return prisma.apiDevice.findUniqueOrThrow({
    where: { id: deviceId },
    select: { pushEndpoint: true, pushFailureCount: true, pushFailedAt: true, pushCreatedAt: true },
  });
}

const fetchMock = vi.fn<typeof fetch>();

describe("API v1 push subscriptions", () => {
  let alice: { id: string };
  let bob: { id: string };
  let phone: { id: string; token: string };
  let tablet: { id: string; token: string };
  let bobPhone: { id: string; token: string };

  beforeAll(async () => {
    resetVapidKeyCacheForTests();
    [alice, bob] = await Promise.all([createUser(), createUser()]);
    const mk = async (userId: string, name: string) => {
      const { device, token } = await createApiDevice({ userId, name });
      return { id: device.id, token };
    };
    phone = await mk(alice.id, "Pixel");
    tablet = await mk(alice.id, "Tab");
    bobPhone = await mk(bob.id, "Bob's phone");
  });

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    resetPushTestThrottleForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    request.session = null;
  });

  afterAll(() => {
    delete process.env.UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS;
  });

  it("hands out one stable VAPID public key, to signed-in callers only", async () => {
    useBearer(null);
    expect((await vapid()).status).toBe(401);

    useBearer(phone.token);
    const first = await json(await vapid());
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(first.algorithm).toBe("ES256");
    resetVapidKeyCacheForTests();
    expect((await json(await vapid())).publicKey).toBe(first.publicKey);

    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "push." } } });
    expect(rows.map((row) => row.key).sort()).toEqual(["push.vapidPrivateKey", "push.vapidPublicKey"]);
  });

  it("requires a device token: a web session cannot register push", async () => {
    useBearer(null);
    request.session = await createSession(alice.id, false);
    const response = await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, makeSubscription()), params(phone.id));
    expect(response.status).toBe(401);
  });

  it("stores a subscription idempotently and shows it on the device list", async () => {
    useBearer(phone.token);
    const subscription = makeSubscription();

    const first = await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, subscription), params(phone.id));
    expect(first.status).toBe(200);
    const body = await json(first);
    expect(body.push).toMatchObject({ deviceId: phone.id, endpoint: subscription.endpoint, failedAt: null, failureCount: 0 });
    expect(JSON.stringify(body)).not.toContain(subscription.keys.auth);

    const again = await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, subscription), params(phone.id));
    expect(again.status).toBe(200);
    expect((await json(again)).push.createdAt).toBe(body.push.createdAt);

    const devices = (await json(await listDevices())).devices as Json[];
    const me = devices.find((device) => device.id === phone.id)!;
    expect(me).toMatchObject({ current: true, pushSubscribed: true });
    expect(me.pushEndpoint).toBeUndefined();
    expect(devices.find((device) => device.id === tablet.id)).toMatchObject({ pushSubscribed: false });

    // A new endpoint replaces the old one and starts a fresh failure record.
    await prisma.apiDevice.update({ where: { id: phone.id }, data: { pushFailureCount: 2, pushFailedAt: new Date() } });
    const replaced = await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, makeSubscription()), params(phone.id));
    expect(replaced.status).toBe(200);
    expect(await pushState(phone.id)).toMatchObject({ pushFailureCount: 0, pushFailedAt: null });
  });

  it("lets a device manage only its own subscription", async () => {
    useBearer(phone.token);
    const subscription = makeSubscription();

    // Alice's other device: visible to her, but not this device's to change.
    const sibling = await putPush(jsonRequest("PUT", `devices/${tablet.id}/push`, subscription), params(tablet.id));
    expect(sibling.status).toBe(403);
    expect((await json(sibling)).error.code).toBe("forbidden");

    // Bob's device and a made-up id look identical: 404.
    for (const id of [bobPhone.id, "nope"]) {
      expect((await putPush(jsonRequest("PUT", `devices/${id}/push`, subscription), params(id))).status).toBe(404);
      expect((await deletePush(jsonRequest("DELETE", `devices/${id}/push`), params(id))).status).toBe(404);
      expect((await testPush(jsonRequest("POST", `devices/${id}/push/test`), params(id))).status).toBe(404);
    }
    expect((await deletePush(jsonRequest("DELETE", `devices/${tablet.id}/push`), params(tablet.id))).status).toBe(403);
    expect((await pushState(tablet.id)).pushEndpoint).toBeNull();
    expect((await pushState(bobPhone.id)).pushEndpoint).toBeNull();
  });

  it("rejects endpoints that could reach the server's own network", async () => {
    useBearer(phone.token);
    const cases = [
      "http://ntfy.sh/topic",
      "https://ntfy.sh:8443/topic",
      "https://127.0.0.1/topic",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/topic",
      "https://localhost/topic",
      "https://private.example/topic",
      "https://user:pw@ntfy.sh/topic",
    ];
    for (const endpoint of cases) {
      const response = await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, makeSubscription(endpoint)), params(phone.id));
      expect(response.status, endpoint).toBe(422);
      expect((await json(response)).error.code, endpoint).toBe("endpoint_rejected");
    }

    const badKeys = makeSubscription();
    badKeys.keys.p256dh = "AAAA";
    const response = await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, badKeys), params(phone.id));
    expect(response.status).toBe(422);
    expect((await json(response)).error.code).toBe("validation_failed");

    expect((await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, { endpoint: "https://ntfy.sh/x" }), params(phone.id))).status).toBe(422);
  });

  it("sends a test push with the Web Push headers and rate-limits it", async () => {
    useBearer(tablet.token);
    expect((await testPush(jsonRequest("POST", `devices/${tablet.id}/push/test`), params(tablet.id))).status).toBe(409);

    const subscription = makeSubscription();
    await putPush(jsonRequest("PUT", `devices/${tablet.id}/push`, subscription), params(tablet.id));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await testPush(jsonRequest("POST", `devices/${tablet.id}/push/test`), params(tablet.id));
      expect(response.status, `attempt ${attempt}`).toBe(200);
    }
    const limited = await testPush(jsonRequest("POST", `devices/${tablet.id}/push/test`), params(tablet.id));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe(subscription.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("60");
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=[A-Za-z0-9_-]{87}$/);
    expect(Buffer.from(init.body as Uint8Array).includes(Buffer.from("Smart Garage"))).toBe(false);

    // The test push reports a dead subscription and removes it.
    resetPushTestThrottleForTests();
    fetchMock.mockResolvedValue(new Response(null, { status: 410 }));
    const gone = await testPush(jsonRequest("POST", `devices/${tablet.id}/push/test`), params(tablet.id));
    expect(gone.status).toBe(502);
    expect((await json(gone)).error.code).toBe("push_subscription_gone");
    expect((await pushState(tablet.id)).pushEndpoint).toBeNull();
  });

  it("removes a subscription on DELETE", async () => {
    useBearer(phone.token);
    await putPush(jsonRequest("PUT", `devices/${phone.id}/push`, makeSubscription()), params(phone.id));
    expect((await deletePush(jsonRequest("DELETE", `devices/${phone.id}/push`), params(phone.id))).status).toBe(204);
    expect((await pushState(phone.id)).pushEndpoint).toBeNull();
    // Deleting again is fine.
    expect((await deletePush(jsonRequest("DELETE", `devices/${phone.id}/push`), params(phone.id))).status).toBe(204);
  });

  describe("as a notification channel", () => {
    let owner: { id: string };
    let devA: { id: string; token: string };
    let devB: { id: string; token: string };

    /** Quiet hours in UTC that cover this very moment. */
    function quietHoursNow() {
      const hour = new Date().getUTCHours();
      return hour < 12
        ? { quietHoursStart: "00:00", quietHoursEnd: "12:00" }
        : { quietHoursStart: "12:00", quietHoursEnd: "00:00" };
    }

    beforeAll(async () => {
      owner = await createUser();
      const vehicle = await createVehicle(owner.id, { make: "Honda", model: "Civic" });
      await prisma.vehicleMaintenanceSchedule.create({
        data: {
          vehicleId: vehicle.id,
          customName: "Brake fluid",
          intervalMonths: 12,
          lastPerformedAt: new Date(Date.now() - 2 * 365 * 86_400_000),
        },
      });
      for (const [key, name] of [
        ["a", "Phone"],
        ["b", "Tablet"],
      ] as const) {
        const { device, token } = await createApiDevice({ userId: owner.id, name });
        if (key === "a") devA = { id: device.id, token };
        else devB = { id: device.id, token };
      }
      await prisma.userNotificationSettings.create({
        data: {
          userId: owner.id,
          deliveryImmediate: true,
          deliveryScheduled: false,
          quietHoursEnabled: false,
          minIntervalHours: 6,
          timezone: "UTC",
        },
      });
    });

    it("counts as enabled only once a device has registered", async () => {
      useBearer(devA.token);
      const before = await json(await getNotifications());
      expect(before).toMatchObject({ mobilePushEnabled: true, mobilePushDevices: 0 });
      expect(getEnabledChannels((await findNotificationSettings(owner.id))!)).toEqual([]);

      await putPush(jsonRequest("PUT", `devices/${devA.id}/push`, makeSubscription()), params(devA.id));
      useBearer(devB.token);
      await putPush(jsonRequest("PUT", `devices/${devB.id}/push`, makeSubscription()), params(devB.id));

      const after = await json(await getNotifications());
      expect(after).toMatchObject({ mobilePushEnabled: true, mobilePushDevices: 2 });
      expect(getEnabledChannels((await findNotificationSettings(owner.id))!)).toEqual(["push"]);
    });

    it("honours quiet hours and the minimum interval exactly like the other channels", async () => {
      await prisma.userNotificationSettings.update({
        where: { userId: owner.id },
        data: { quietHoursEnabled: true, ...quietHoursNow(), lastMaintenanceAlertAt: null },
      });
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).not.toHaveBeenCalled();

      await prisma.userNotificationSettings.update({
        where: { userId: owner.id },
        data: { quietHoursEnabled: false, lastMaintenanceAlertAt: new Date(Date.now() - 60_000) },
      });
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).not.toHaveBeenCalled();

      await prisma.userNotificationSettings.update({
        where: { userId: owner.id },
        data: { lastMaintenanceAlertAt: new Date(Date.now() - 7 * 3_600_000) },
      });
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const targets = fetchMock.mock.calls.map((call) => call[0]);
      expect(new Set(targets).size).toBe(2);
      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers.Urgency).toBe("high");
      expect(headers["Content-Encoding"]).toBe("aes128gcm");

      const settings = await findNotificationSettings(owner.id);
      expect(settings!.lastMaintenanceAlertAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
    });

    it("can be switched off through the settings API", async () => {
      useBearer(devA.token);
      const off = await patchNotifications(jsonRequest("PATCH", "notification-settings", { mobilePushEnabled: false }));
      expect(off.status).toBe(200);
      expect(await json(off)).toMatchObject({ mobilePushEnabled: false, mobilePushDevices: 2 });
      expect(getEnabledChannels((await findNotificationSettings(owner.id))!)).toEqual([]);

      await prisma.userNotificationSettings.update({ where: { userId: owner.id }, data: { lastMaintenanceAlertAt: null } });
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).not.toHaveBeenCalled();

      expect((await patchNotifications(jsonRequest("PATCH", "notification-settings", { mobilePushEnabled: true }))).status).toBe(200);
    });

    it("drops a subscription on 410 and after repeated 507s, backs off otherwise", async () => {
      await prisma.userNotificationSettings.update({ where: { userId: owner.id }, data: { lastMaintenanceAlertAt: null } });
      const endpointA = (await pushState(devA.id)).pushEndpoint!;
      fetchMock.mockImplementation(async (input) =>
        new Response(null, { status: String(input) === endpointA ? 410 : 503 }),
      );
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await pushState(devA.id)).pushEndpoint).toBeNull();
      expect(await pushState(devB.id)).toMatchObject({ pushFailureCount: 1 });
      expect((await pushState(devB.id)).pushFailedAt).not.toBeNull();

      // Nothing was delivered, so the alert is not marked sent and will be retried…
      expect((await findNotificationSettings(owner.id))!.lastMaintenanceAlertAt).toBeNull();
      // …but the failing device is left alone while it backs off.
      fetchMock.mockClear();
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).not.toHaveBeenCalled();

      // ntfy's 507 ("no subscriber"): the third consecutive failure removes the subscription.
      await prisma.apiDevice.update({ where: { id: devB.id }, data: { pushFailedAt: new Date(Date.now() - 86_400_000), pushFailureCount: 2 } });
      fetchMock.mockResolvedValue(new Response(null, { status: 507 }));
      await maybeSendMaintenanceAlerts(owner.id, "en");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await pushState(devB.id)).pushEndpoint).toBeNull();
      expect((await findNotificationSettings(owner.id))!.mobilePushDevices).toBe(0);
    });
  });
});
