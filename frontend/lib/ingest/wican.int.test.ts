import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/ingest/wican/route";
import { WICAN_QUIET_MS, WICAN_SOURCE, flushQuietWicanTrips } from "@/lib/ingest/wican";
import { createUser, createVehicle } from "@/test/integration/factories";

const TOKEN = "wican-test-token";
const HOUR = 60 * 60 * 1000;

function post(vehicleId: string, body: unknown, auth: string | null = `Bearer ${TOKEN}`) {
  return POST(
    new Request(`http://test/api/ingest/wican?vehicle=${encodeURIComponent(vehicleId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function setup(currentOdometerKm = 10_000, manualAgoMs = 2 * HOUR) {
  const user = await createUser();
  const vehicle = await createVehicle(user.id);
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { currentOdometerKm } });
  const manual = await prisma.odometerLog.create({
    data: {
      vehicleId: vehicle.id,
      odometerKm: currentOdometerKm,
      source: "manual",
      createdByUserId: user.id,
      recordedAt: new Date(Date.now() - manualAgoMs),
    },
  });
  return { user, vehicle, manual };
}

const logs = (vehicleId: string) =>
  prisma.odometerLog.findMany({ where: { vehicleId }, orderBy: { recordedAt: "asc" } });

const odometerOf = async (vehicleId: string) =>
  (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).currentOdometerKm;

/** Pretends the adapter went quiet (trip over) `byMs` ago. */
async function goQuiet(vehicleId: string, byMs = WICAN_QUIET_MS + 60_000) {
  const state = await prisma.wicanVehicleState.findUniqueOrThrow({ where: { vehicleId } });
  await prisma.wicanVehicleState.update({
    where: { vehicleId },
    data: { lastSeenAt: new Date(state.lastSeenAt!.getTime() - byMs) },
  });
}

/** A whole trip: POSTs, then quiet, then the worker sweep. */
async function trip(vehicleId: string, bodies: unknown[]) {
  for (const body of bodies) expect((await post(vehicleId, body)).status).toBe(204);
  await goQuiet(vehicleId);
  await flushQuietWicanTrips();
}

beforeAll(() => {
  process.env.WICAN_INGEST_TOKEN = TOKEN;
});
afterEach(() => {
  delete process.env.WICAN_ODO_UNIT;
  vi.restoreAllMocks();
});
afterAll(() => {
  delete process.env.WICAN_INGEST_TOKEN;
});

describe("POST /api/ingest/wican auth", () => {
  it("rejects a missing, wrong or non-bearer token with 401", async () => {
    const { vehicle } = await setup();
    const body = { autopid_data: { ODOMETER: 20_000 } };
    expect((await post(vehicle.id, body, null)).status).toBe(401);
    expect((await post(vehicle.id, body, "Bearer nope")).status).toBe(401);
    expect((await post(vehicle.id, body, TOKEN)).status).toBe(401);
    expect(await odometerOf(vehicle.id)).toBe(10_000);
  });

  it("rejects everything while WICAN_INGEST_TOKEN is unset", async () => {
    const { vehicle } = await setup();
    delete process.env.WICAN_INGEST_TOKEN;
    try {
      expect((await post(vehicle.id, { autopid_data: { ODOMETER: 20_000 } })).status).toBe(401);
      expect((await post(vehicle.id, {}, "Bearer ")).status).toBe(401);
    } finally {
      process.env.WICAN_INGEST_TOKEN = TOKEN;
    }
  });

  it("does not accept a device token or session in place of the ingest token", async () => {
    const { vehicle } = await setup();
    const res = await post(vehicle.id, { autopid_data: { ODOMETER: 20_000 } }, "Bearer sgd_whatever");
    expect(res.status).toBe(401);
  });
});

const odo = (km: number) => ({ autopid_data: { ODOMETER: km } });

describe("POST /api/ingest/wican odometer", () => {
  it("saves nothing while the adapter is still posting", async () => {
    const { vehicle } = await setup();
    for (const km of [10_100, 10_150, 10_200]) {
      expect((await post(vehicle.id, odo(km))).status).toBe(204);
    }
    expect(await flushQuietWicanTrips()).toBe(0);
    expect(await logs(vehicle.id)).toHaveLength(1);
    expect(await odometerOf(vehicle.id)).toBe(10_000);
  });

  it("saves the trip's last value through the quick-update path once quiet", async () => {
    const { vehicle, user } = await setup();
    await trip(vehicle.id, [odo(10_100), odo(10_180), odo(10_250.4)]);
    expect(await odometerOf(vehicle.id)).toBe(10_250);
    const all = await logs(vehicle.id);
    expect(all).toHaveLength(2);
    const state = await prisma.wicanVehicleState.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    expect(all[1]).toMatchObject({ odometerKm: 10_250, source: WICAN_SOURCE, createdByUserId: user.id });
    // Dated when the adapter last posted, not when the sweep ran.
    expect(all[1].recordedAt.getTime()).toBe(state.lastSeenAt!.getTime());
    expect(state.pendingOdometerKm).toBeNull();
  });

  it("one reading per trip", async () => {
    const { vehicle } = await setup();
    await trip(vehicle.id, [odo(10_100), odo(10_120)]);
    await trip(vehicle.id, [odo(10_130), odo(10_190)]);
    expect((await logs(vehicle.id)).map((l) => l.odometerKm)).toEqual([10_000, 10_120, 10_190]);
  });

  it("saves the previous trip on the next trip's first POST if the sweep has not run", async () => {
    const { vehicle } = await setup();
    await post(vehicle.id, odo(10_100));
    await post(vehicle.id, odo(10_140));
    await goQuiet(vehicle.id);
    await post(vehicle.id, odo(10_141)); // new trip starts
    expect((await logs(vehicle.id)).map((l) => l.odometerKm)).toEqual([10_000, 10_140]);
    const state = await prisma.wicanVehicleState.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    expect(state.pendingOdometerKm).toBe(10_141);
  });

  it("converts miles to km when WICAN_ODO_UNIT=mi", async () => {
    const { vehicle } = await setup();
    process.env.WICAN_ODO_UNIT = "mi";
    await trip(vehicle.id, [odo(7_000)]);
    expect(await odometerOf(vehicle.id)).toBe(Math.round(7_000 * 1.609344));
  });

  it("skips a trip that ends no higher than the last reading", async () => {
    const { vehicle } = await setup();
    await trip(vehicle.id, [odo(9_000), odo(10_000)]);
    expect(await logs(vehicle.id)).toHaveLength(1);
    expect(await odometerOf(vehicle.id)).toBe(10_000);
  });

  it("keeps the trip's highest value if a POST reports less", async () => {
    const { vehicle } = await setup();
    await trip(vehicle.id, [odo(10_200), odo(10_150)]);
    expect(await odometerOf(vehicle.id)).toBe(10_200);
  });

  it("404s an unknown or deleted vehicle, 400s a bad request", async () => {
    const { vehicle } = await setup();
    expect((await post("nope", odo(1))).status).toBe(404);
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { deletedAt: new Date() } });
    expect((await post(vehicle.id, odo(20_000))).status).toBe(404);
    expect((await post("", odo(1))).status).toBe(400);
    expect((await post(vehicle.id, "{not json")).status).toBe(400);
  });

  it("never logs the boot payload's Wi-Fi credentials", async () => {
    const { vehicle } = await setup();
    const secret = "hunter2-wifi-password";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await trip(vehicle.id, [
      { config: { wifi_ssid: "home", wifi_pass: secret }, status: { sta_pass: secret }, ...odo(10_500) },
    ]);
    expect(await odometerOf(vehicle.id)).toBe(10_500);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    }
  });
});

describe("POST /api/ingest/wican distance-since-codes-cleared fallback", () => {
  const counter = (km: number) => ({ autopid_data: { DIST_SINCE_CODES_CLEARED: km } });

  it("anchors on the first counter value, then adds the distance driven", async () => {
    const { vehicle } = await setup();
    await trip(vehicle.id, [counter(500), counter(560), counter(620)]);
    expect(await odometerOf(vehicle.id)).toBe(10_120);
    expect((await logs(vehicle.id)).at(-1)!.source).toBe(WICAN_SOURCE);
  });

  it("re-anchors on a newer manual reading", async () => {
    const { vehicle, user } = await setup();
    await trip(vehicle.id, [counter(500), counter(600)]); // 10 100
    await prisma.odometerLog.create({
      data: { vehicleId: vehicle.id, odometerKm: 10_150, source: "manual", createdByUserId: user.id },
    });
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { currentOdometerKm: 10_150 } });

    await trip(vehicle.id, [counter(610), counter(700)]); // anchor 10 150 @ 610
    expect(await odometerOf(vehicle.id)).toBe(10_240);
  });

  it("re-anchors when the counter drops (codes cleared)", async () => {
    const { vehicle } = await setup();
    await trip(vehicle.id, [counter(500), counter(600)]); // 10 100
    await trip(vehicle.id, [counter(3), counter(83)]); // cleared: anchor 10 100 @ 3
    expect(await odometerOf(vehicle.id)).toBe(10_180);
  });

  it("prefers ODOMETER when both are present", async () => {
    const { vehicle } = await setup();
    await trip(vehicle.id, [{ autopid_data: { ODOMETER: 10_300, DIST_SINCE_CODES_CLEARED: 99_999 } }]);
    expect(await odometerOf(vehicle.id)).toBe(10_300);
  });

  it("does nothing without a manual reading to anchor to", async () => {
    const user = await createUser();
    const vehicle = await createVehicle(user.id);
    expect((await post(vehicle.id, counter(500))).status).toBe(204);
    expect((await post(vehicle.id, counter(900))).status).toBe(204);
    expect(await flushQuietWicanTrips()).toBe(0);
    expect(await logs(vehicle.id)).toHaveLength(0);
  });
});
