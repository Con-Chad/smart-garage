import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers and services read the request through `next/headers`; stand
// in for Next's request scope with a mutable header set.
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { hashDeviceToken, isWellFormedDeviceToken } from "@/lib/auth/device-token";
import { resetLoginThrottleForTests } from "@/lib/auth/login-throttle";
import { createUserByAdmin } from "@/lib/services/auth";
import { getVehiclesForCurrentUser } from "@/lib/services/vehicles";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as logout } from "@/app/api/v1/auth/logout/route";
import { GET as me } from "@/app/api/v1/me/route";
import { GET as listDevices } from "@/app/api/v1/devices/route";
import { DELETE as revokeDevice } from "@/app/api/v1/devices/[deviceId]/route";
import { GET as health } from "@/app/api/v1/health/route";
import { createVehicle } from "@/test/integration/factories";

const PASSWORD = "correct horse battery";

async function createAccount(username: string, isActive = true) {
  return prisma.user.create({
    data: {
      username,
      email: `${username}@smart-garage.local`,
      passwordHash: await hashPassword(PASSWORD),
      isActive,
      preferences: { create: { distanceUnit: "mi", volumeUnit: "gal" } },
    },
  });
}

function loginRequest(body: unknown, ip = "203.0.113.10") {
  return new Request("http://test/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, "user-agent": "SmartGarageAndroid/test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function loginAs(username: string, deviceName = "Pixel") {
  const response = await login(loginRequest({ username, password: PASSWORD, deviceName }));
  expect(response.status).toBe(201);
  return (await response.json()) as { token: string; device: { id: string } };
}

function useBearer(token: string | null) {
  request.headers = new Headers(token ? { authorization: `Bearer ${token}` } : {});
}

describe("API v1 device-token auth", () => {
  beforeAll(async () => {
    await createAccount("alice");
    await createAccount("bob");
    await createAccount("dormant", false);
  });

  beforeEach(() => resetLoginThrottleForTests());
  afterEach(() => useBearer(null));

  it("reports health without authentication", async () => {
    const body = await (await health()).json();
    expect(body).toMatchObject({ service: "smart-garage", status: "ok", apiVersion: 1 });
    expect(body).not.toHaveProperty("stats");
  });

  it("issues a device token and stores only its hash", async () => {
    const { token, device } = await loginAs("alice");
    expect(isWellFormedDeviceToken(token)).toBe(true);

    const row = await prisma.apiDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.tokenHash).toBe(hashDeviceToken(token));
    expect(row.tokenHash).not.toContain(token.slice(4));
    expect(row.name).toBe("Pixel");
    expect(row.userAgent).toBe("SmartGarageAndroid/test");
  });

  it("rejects bad credentials identically", async () => {
    for (const body of [
      { username: "alice", password: "wrong password" },
      { username: "nobody", password: PASSWORD },
      { username: "dormant", password: PASSWORD },
    ]) {
      const response = await login(loginRequest(body));
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("invalid_credentials");
    }
  });

  it("rejects malformed bodies", async () => {
    expect((await login(loginRequest("not json"))).status).toBe(400);
    expect((await login(loginRequest({ username: "alice" }))).status).toBe(400);
  });

  it("rate-limits repeated failures, even for the right password", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < 5; i++) {
      const response = await login(loginRequest({ username: "bob", password: "nope" }, ip));
      expect(response.status).toBe(401);
    }
    const blocked = await login(loginRequest({ username: "bob", password: PASSWORD }, ip));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Another address is unaffected.
    const elsewhere = await login(loginRequest({ username: "bob", password: PASSWORD }, "192.0.2.1"));
    expect(elsewhere.status).toBe(201);
  });

  it("authenticates /me with the bearer token and returns display units", async () => {
    const { token, device } = await loginAs("alice");

    useBearer(null);
    expect((await me()).status).toBe(401);

    useBearer("sgd_" + "x".repeat(43));
    expect((await me()).status).toBe(401);

    useBearer(token);
    const body = await (await me()).json();
    expect(body.user.username).toBe("alice");
    expect(body.device.id).toBe(device.id);
    expect(body.preferences).toMatchObject({ distanceUnit: "mi", volumeUnit: "gal" });
    expect(body.units).toEqual({ distance: "km", volume: "l", money: "cents" });
  });

  it("lets existing cookie-based services work through the bearer token", async () => {
    const alice = await prisma.user.findUniqueOrThrow({ where: { username: "alice" } });
    const bob = await prisma.user.findUniqueOrThrow({ where: { username: "bob" } });
    const mine = await createVehicle(alice.id, { make: "Mazda" });
    await createVehicle(bob.id, { make: "Volvo" });

    const { token } = await loginAs("alice");
    useBearer(token);
    const vehicles = await getVehiclesForCurrentUser();
    expect(vehicles.map((v) => v.id)).toEqual([mine.id]);
  });

  it("lists only the caller's devices and isolates revocation", async () => {
    const aliceLogin = await loginAs("alice", "Alice phone");
    const bobLogin = await loginAs("bob", "Bob phone");

    useBearer(aliceLogin.token);
    const { devices } = await (await listDevices()).json();
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.every((d: { name: string }) => d.name !== "Bob phone")).toBe(true);
    expect(devices.find((d: { current: boolean }) => d.current).id).toBe(aliceLogin.device.id);
    expect(devices[0]).not.toHaveProperty("tokenHash");

    const params = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) });
    const foreign = await revokeDevice(new Request("http://test"), params(bobLogin.device.id));
    expect(foreign.status).toBe(404);

    useBearer(bobLogin.token);
    expect((await me()).status).toBe(200);

    useBearer(aliceLogin.token);
    const own = await revokeDevice(new Request("http://test"), params(aliceLogin.device.id));
    expect(own.status).toBe(204);
    expect((await me()).status).toBe(401);
  });

  it("revokes the current device on logout", async () => {
    const { token } = await loginAs("bob");
    useBearer(token);
    expect((await logout()).status).toBe(204);
    expect((await me()).status).toBe(401);
  });

  it("stops accepting tokens of deactivated users", async () => {
    const user = await createAccount("leaving");
    const { token } = await loginAs("leaving");
    useBearer(token);
    expect((await me()).status).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await me()).status).toBe(401);
  });
});

describe("instance preference defaults for new users", () => {
  const keys = [
    "DEFAULT_LOCALE",
    "DEFAULT_TIMEZONE",
    "DEFAULT_CURRENCY",
    "DEFAULT_DISTANCE_UNIT",
    "DEFAULT_VOLUME_UNIT",
  ] as const;
  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });

  it("keeps upstream schema defaults when unset", async () => {
    const user = await createUserByAdmin({ username: "plain_user", password: PASSWORD });
    const prefs = await prisma.userPreferences.findUniqueOrThrow({ where: { userId: user.id } });
    expect(prefs).toMatchObject({ distanceUnit: "km", volumeUnit: "l", currency: "EUR" });
  });

  it("applies US defaults from env", async () => {
    Object.assign(process.env, {
      DEFAULT_LOCALE: "en",
      DEFAULT_TIMEZONE: "America/Chicago",
      DEFAULT_CURRENCY: "USD",
      DEFAULT_DISTANCE_UNIT: "mi",
      DEFAULT_VOLUME_UNIT: "gal",
    });
    const user = await createUserByAdmin({ username: "us_user", password: PASSWORD });
    const [prefs, notifications] = await Promise.all([
      prisma.userPreferences.findUniqueOrThrow({ where: { userId: user.id } }),
      prisma.userNotificationSettings.findUniqueOrThrow({ where: { userId: user.id } }),
    ]);
    expect(prefs).toMatchObject({
      locale: "en",
      timezone: "America/Chicago",
      currency: "USD",
      distanceUnit: "mi",
      volumeUnit: "gal",
    });
    expect(notifications.timezone).toBe("America/Chicago");
  });
});
