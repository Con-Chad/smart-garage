import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db/retry";
import { APP_SETTING_KEYS } from "@/lib/repositories/app-settings";

/**
 * The server's VAPID key pair (RFC 8292). Generated once on first use and
 * stored in `AppSetting`, so a self-hoster never has to manage key material
 * through env vars and the key survives container restarts. The public key
 * is handed to apps (`GET /api/v1/push/vapid`); the private key never leaves
 * the server. Rotating the key would invalidate every subscription, so there
 * is deliberately no UI for it.
 */

export type VapidKeys = {
  /** Uncompressed P-256 point (65 bytes), base64url without padding. */
  publicKey: string;
  /** 32-byte scalar, base64url without padding. */
  privateKey: string;
};

/** Contact for the push service, sent as the JWT `sub` claim (mailto: or https:). */
export function vapidSubject(): string {
  const configured = process.env.PUSH_VAPID_SUBJECT?.trim();
  if (configured && /^(mailto:|https:)/i.test(configured)) return configured;
  return "https://github.com/con-chad/smart-garage";
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const priv = privateKey.export({ format: "jwk" }) as { d: string };
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pub.x, "base64url"),
    Buffer.from(pub.y, "base64url"),
  ]);
  return { publicKey: point.toString("base64url"), privateKey: priv.d };
}

/** Rebuilds a signing key from the stored pair. */
export function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const point = Buffer.from(keys.publicKey, "base64url");
  if (point.length !== 65 || point[0] !== 0x04) throw new Error("Invalid VAPID public key");
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
      d: keys.privateKey,
    },
    format: "jwk",
  });
}

let cached: VapidKeys | null = null;

async function readStoredKeys(): Promise<VapidKeys | null> {
  const rows = await withDbRetry(() =>
    prisma.appSetting.findMany({
      where: { key: { in: [APP_SETTING_KEYS.vapidPublicKey, APP_SETTING_KEYS.vapidPrivateKey] } },
    }),
  );
  const publicKey = rows.find((row) => row.key === APP_SETTING_KEYS.vapidPublicKey)?.value;
  const privateKey = rows.find((row) => row.key === APP_SETTING_KEYS.vapidPrivateKey)?.value;
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

/** The instance's key pair, creating it on first call. Safe under concurrent first calls. */
export async function getOrCreateVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;

  const stored = await readStoredKeys();
  if (stored) return (cached = stored);

  const fresh = generateVapidKeys();
  try {
    await withDbRetry(() =>
      prisma.$transaction([
        prisma.appSetting.create({ data: { key: APP_SETTING_KEYS.vapidPublicKey, value: fresh.publicKey } }),
        prisma.appSetting.create({ data: { key: APP_SETTING_KEYS.vapidPrivateKey, value: fresh.privateKey } }),
      ]),
    );
    return (cached = fresh);
  } catch (error) {
    // Another request created the pair first: use theirs, never a second pair.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await readStoredKeys();
      if (winner) return (cached = winner);
    }
    throw error;
  }
}

/** Drops the in-process cache (tests swap databases between files). */
export function resetVapidKeyCacheForTests(): void {
  cached = null;
}
