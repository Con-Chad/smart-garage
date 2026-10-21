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

export type ApiDeviceSummary = {
  id: string;
  name: string;
  tokenPrefix: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const summarySelect = {
  id: true,
  name: true,
  tokenPrefix: true,
  userAgent: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

/** Creates a device and returns the plaintext token — the only time it exists. */
export async function createApiDevice(input: {
  userId: string;
  name: string;
  userAgent?: string | null;
}): Promise<{ device: ApiDeviceSummary; token: string }> {
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
  return { device, token };
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
  return withDbRetry(() =>
    prisma.apiDevice.findMany({
      where: { userId },
      select: summarySelect,
      orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    }),
  );
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
