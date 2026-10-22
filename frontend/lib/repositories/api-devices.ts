import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db/retry";
import {
  deviceTokenDisplayPrefix,
  generateDeviceToken,
  hashDeviceToken,
} from "@/lib/auth/device-token";

/** `lastUsedAt` is refreshed at most this often, so reads don't all become writes. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

const MAX_DEVICE_NAME_LENGTH = 80;
const MAX_USER_AGENT_LENGTH = 200;

/**
 * Active (not revoked) devices one account may hold. Every `/auth/login`
 * mints a permanent token, so without a cap a leaked password or a looping
 * client could pile up credentials forever (S-7 in the 2026-10-22 audit).
 * `MAX_DEVICES_PER_USER` overrides; the user frees a slot by revoking a
 * device under Settings → Mobile devices.
 */
export const DEFAULT_MAX_DEVICES_PER_USER = 20;

export function maxDevicesPerUser(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt((env.MAX_DEVICES_PER_USER ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_DEVICES_PER_USER;
}

export class DeviceLimitReachedError extends Error {
  constructor(readonly limit: number) {
    super("DEVICE_LIMIT_REACHED");
  }
}

export async function countActiveDevicesForUser(userId: string): Promise<number> {
  return withDbRetry(() => prisma.apiDevice.count({ where: { userId, revokedAt: null } }));
}

export type ApiDeviceSummary = {
  id: string;
  name: string;
  tokenPrefix: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** Whether the device registered a push subscription; the endpoint itself stays private. */
  pushSubscribed: boolean;
  pushCreatedAt: Date | null;
  pushFailedAt: Date | null;
};

const summarySelect = {
  id: true,
  name: true,
  tokenPrefix: true,
  userAgent: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
  pushEndpoint: true,
  pushCreatedAt: true,
  pushFailedAt: true,
} as const;

function toSummary(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  pushEndpoint: string | null;
  pushCreatedAt: Date | null;
  pushFailedAt: Date | null;
}): ApiDeviceSummary {
  const { pushEndpoint, ...rest } = row;
  return { ...rest, pushSubscribed: pushEndpoint != null };
}

/**
 * Creates a device and returns the plaintext token — the only time it exists.
 * Throws `DeviceLimitReachedError` once the account holds `maxDevicesPerUser()`
 * active devices.
 */
export async function createApiDevice(input: {
  userId: string;
  name: string;
  userAgent?: string | null;
}): Promise<{ device: ApiDeviceSummary; token: string }> {
  const limit = maxDevicesPerUser();
  if ((await countActiveDevicesForUser(input.userId)) >= limit) {
    throw new DeviceLimitReachedError(limit);
  }

  const token = generateDeviceToken();
  const device = await withDbRetry(() =>
    prisma.apiDevice.create({
      data: {
        userId: input.userId,
        name: input.name.trim().slice(0, MAX_DEVICE_NAME_LENGTH) || "Mobile device",
        tokenHash: hashDeviceToken(token),
        tokenPrefix: deviceTokenDisplayPrefix(token),
        userAgent: input.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) || null,
        lastUsedAt: new Date(),
      },
      select: summarySelect,
    }),
  );
  return { device: toSummary(device), token };
}

/** Resolves an active (not revoked) device and its user from a plaintext token. */
export async function findActiveDeviceByToken(token: string) {
  const device = await withDbRetry(() =>
    prisma.apiDevice.findUnique({
      where: { tokenHash: hashDeviceToken(token) },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            displayName: true,
            role: true,
            isActive: true,
          },
        },
      },
    }),
  );
  if (!device || device.revokedAt) return null;
  return device;
}

export async function touchApiDeviceLastUsed(deviceId: string): Promise<void> {
  const threshold = new Date(Date.now() - LAST_USED_RESOLUTION_MS);
  await prisma.apiDevice.updateMany({
    where: {
      id: deviceId,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }],
    },
    data: { lastUsedAt: new Date() },
  });
}

export async function listApiDevicesForUser(userId: string): Promise<ApiDeviceSummary[]> {
  const rows = await withDbRetry(() =>
    prisma.apiDevice.findMany({
      where: { userId },
      select: summarySelect,
      orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    }),
  );
  return rows.map(toSummary);
}

// ─── Push subscriptions ──────────────────────────────────────────────────

export type DevicePushSubscription = {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: Date;
  failedAt: Date | null;
  failureCount: number;
};

const pushSelect = {
  id: true,
  pushEndpoint: true,
  pushP256dh: true,
  pushAuth: true,
  pushCreatedAt: true,
  pushFailedAt: true,
  pushFailureCount: true,
} as const;

function toPushSubscription(row: {
  id: string;
  pushEndpoint: string | null;
  pushP256dh: string | null;
  pushAuth: string | null;
  pushCreatedAt: Date | null;
  pushFailedAt: Date | null;
  pushFailureCount: number;
}): DevicePushSubscription | null {
  if (!row.pushEndpoint || !row.pushP256dh || !row.pushAuth || !row.pushCreatedAt) return null;
  return {
    deviceId: row.id,
    endpoint: row.pushEndpoint,
    p256dh: row.pushP256dh,
    auth: row.pushAuth,
    createdAt: row.pushCreatedAt,
    failedAt: row.pushFailedAt,
    failureCount: row.pushFailureCount,
  };
}

/** Who owns a device, for the 404-vs-403 decision; null when it doesn't exist or is revoked. */
export async function findActiveDeviceOwner(deviceId: string): Promise<{ userId: string } | null> {
  const row = await withDbRetry(() =>
    prisma.apiDevice.findUnique({ where: { id: deviceId }, select: { userId: true, revokedAt: true } }),
  );
  return row && !row.revokedAt ? { userId: row.userId } : null;
}

export async function findDevicePushSubscription(deviceId: string): Promise<DevicePushSubscription | null> {
  const row = await withDbRetry(() =>
    prisma.apiDevice.findUnique({ where: { id: deviceId }, select: pushSelect }),
  );
  return row ? toPushSubscription(row) : null;
}

/**
 * Stores or replaces a device's subscription. Re-registering the same
 * endpoint and keys is a no-op that keeps `pushCreatedAt`; anything else
 * starts fresh with a clean failure record.
 */
export async function setDevicePushSubscription(
  deviceId: string,
  input: { endpoint: string; p256dh: string; auth: string },
): Promise<DevicePushSubscription> {
  const existing = await findDevicePushSubscription(deviceId);
  if (
    existing &&
    existing.endpoint === input.endpoint &&
    existing.p256dh === input.p256dh &&
    existing.auth === input.auth
  ) {
    return existing;
  }
  const row = await withDbRetry(() =>
    prisma.apiDevice.update({
      where: { id: deviceId },
      data: {
        pushEndpoint: input.endpoint,
        pushP256dh: input.p256dh,
        pushAuth: input.auth,
        pushCreatedAt: new Date(),
        pushFailedAt: null,
        pushFailureCount: 0,
      },
      select: pushSelect,
    }),
  );
  return toPushSubscription(row)!;
}

/** Removes a device's subscription. Returns false when there was none. */
export async function clearDevicePushSubscription(deviceId: string): Promise<boolean> {
  const result = await withDbRetry(() =>
    prisma.apiDevice.updateMany({
      where: { id: deviceId, pushEndpoint: { not: null } },
      data: {
        pushEndpoint: null,
        pushP256dh: null,
        pushAuth: null,
        pushCreatedAt: null,
        pushFailedAt: null,
        pushFailureCount: 0,
      },
    }),
  );
  return result.count > 0;
}

/** Every active device of a user that can receive push. */
export async function listPushSubscriptionsForUser(userId: string): Promise<DevicePushSubscription[]> {
  const rows = await withDbRetry(() =>
    prisma.apiDevice.findMany({
      where: { userId, revokedAt: null, pushEndpoint: { not: null } },
      select: pushSelect,
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map(toPushSubscription).filter((row): row is DevicePushSubscription => row != null);
}

export async function countPushSubscriptionsForUser(userId: string): Promise<number> {
  return withDbRetry(() =>
    prisma.apiDevice.count({ where: { userId, revokedAt: null, pushEndpoint: { not: null } } }),
  );
}

export async function recordPushDelivery(deviceId: string): Promise<void> {
  await withDbRetry(() =>
    prisma.apiDevice.updateMany({
      where: { id: deviceId, pushEndpoint: { not: null } },
      data: { pushFailedAt: null, pushFailureCount: 0 },
    }),
  );
}

export async function recordPushFailure(deviceId: string): Promise<number> {
  const row = await withDbRetry(() =>
    prisma.apiDevice.update({
      where: { id: deviceId },
      data: { pushFailedAt: new Date(), pushFailureCount: { increment: 1 } },
      select: { pushFailureCount: true },
    }),
  );
  return row.pushFailureCount;
}

/** Revokes one of the user's own devices. Returns false if it isn't theirs. */
export async function revokeApiDeviceForUser(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const result = await withDbRetry(() =>
    prisma.apiDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
  return result.count > 0;
}
