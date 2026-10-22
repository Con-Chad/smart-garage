import { createCipheriv, createECDH, createSign, hkdfSync, randomBytes } from "node:crypto";
import { vapidPrivateKeyObject, type VapidKeys } from "@/lib/notifications/push/vapid";

/**
 * Web Push transport without a dependency: RFC 8291 message encryption
 * (`aes128gcm`, RFC 8188 framing) and RFC 8292 VAPID request signing, built
 * on `node:crypto` only. The push service — ntfy.sh for UnifiedPush, or any
 * other distributor the app registers — only ever sees ciphertext; the
 * subscription's `p256dh`/`auth` keys live on the phone and the server.
 *
 * Message size: Web Push caps the body at 4096 bytes. Payloads here are a
 * few hundred bytes of JSON, so one record is enough.
 */

export type PushSubscription = {
  endpoint: string;
  /** Receiver's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** Receiver's 16-byte auth secret, base64url. */
  auth: string;
};

export type WebPushOptions = {
  /** Seconds the push service may hold the message for an offline device. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Replaces an earlier pending message with the same topic (max 32 url-safe chars). */
  topic?: string;
  fetchImpl?: typeof fetch;
};

export type WebPushResult =
  | { ok: true; status: number }
  | {
      ok: false;
      status: number | null;
      error: string;
      /** The subscription is dead (404/410): remove it instead of retrying. */
      gone: boolean;
    };

const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = RECORD_SIZE - 16 /* tag */ - 1 /* delimiter */ - 86 /* header */;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function decodeKey(value: string, name: string, expectedLength: number): Buffer {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw new Error(`${name} is not base64url`);
  }
  if (bytes.length !== expectedLength) throw new Error(`${name} must be ${expectedLength} bytes`);
  return bytes;
}

/** Checks that a subscription's keys are well-formed before storing them. */
export function validateSubscriptionKeys(keys: { p256dh: string; auth: string }): { ok: true } | { ok: false; reason: string } {
  try {
    const point = decodeKey(keys.p256dh, "p256dh", 65);
    if (point[0] !== 0x04) return { ok: false, reason: "p256dh must be an uncompressed P-256 point" };
    decodeKey(keys.auth, "auth", 16);
    // A point that isn't on the curve throws here rather than at send time.
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid subscription keys" };
  }
}

/**
 * RFC 8291 encryption. Returns the `aes128gcm` body: a header carrying the
 * salt and the sender's ephemeral public key, followed by one encrypted
 * record. Keys are derived with HKDF-SHA256 exactly as in RFC 8291 §3.
 */
export function encryptPayload(plaintext: Buffer, subscription: Pick<PushSubscription, "p256dh" | "auth">): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("Push payload is too large");
  const receiverPublic = decodeKey(subscription.p256dh, "p256dh", 65);
  const authSecret = decodeKey(subscription.auth, "auth", 16);

  const sender = createECDH("prime256v1");
  const senderPublic = sender.generateKeys();
  const sharedSecret = sender.computeSecret(receiverPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));

  const salt = randomBytes(16);
  const contentKey = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // Single, final record: plaintext || 0x02 delimiter (no padding needed).
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, ciphertext]);
}

/** RFC 8292 §2: a short-lived ES256 JWT bound to the push service's origin. */
export function createVapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = base64url(
    JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS, sub: subject }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: vapidPrivateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${base64url(signature)}, k=${keys.publicKey}`;
}

/** Encrypts and POSTs one message to a subscription's push service. */
export async function sendWebPush(
  subscription: PushSubscription,
  payload: Buffer | string,
  vapid: { keys: VapidKeys; subject: string },
  options: WebPushOptions = {},
): Promise<WebPushResult> {
  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPayload(Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8"), subscription);
    authorization = createVapidAuthorization(subscription.endpoint, vapid.keys, vapid.subject);
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : "encryption failed", gone: false };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    "Content-Length": String(body.length),
    TTL: String(options.ttl ?? DEFAULT_TTL_SECONDS),
    Urgency: options.urgency ?? "normal",
    Authorization: authorization,
  };
  if (options.topic) headers.Topic = options.topic;

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(subscription.endpoint, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : "request failed", gone: false };
  }

  if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
  const text = await response.text().catch(() => "");
  return {
    ok: false,
    status: response.status,
    error: `push service responded ${response.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
    gone: response.status === 404 || response.status === 410,
  };
}
