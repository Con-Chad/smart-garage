import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateVapidKeys } from "@/lib/notifications/push/vapid";
import {
  createVapidAuthorization,
  encryptPayload,
  sendWebPush,
  validateSubscriptionKeys,
} from "@/lib/notifications/push/web-push";

/** A receiver as the phone would be: a P-256 pair plus a 16-byte auth secret. */
function makeReceiver() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") },
  };
}

/** Independent RFC 8291 / RFC 8188 decryption, written from the spec rather than the encoder. */
function decrypt(body: Buffer, receiver: ReturnType<typeof makeReceiver>): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  expect(recordSize).toBe(4096);
  expect(keyLength).toBe(65);
  expect(ciphertext.length).toBeLessThanOrEqual(recordSize);

  const shared = receiver.ecdh.computeSecret(senderPublic);
  const receiverPublic = receiver.ecdh.getPublicKey();
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, receiver.auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // Strip the delimiter (0x02 on the last record) and any zero padding after it.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(0x02);
  return padded.subarray(0, end);
}

describe("web push encryption (RFC 8291)", () => {
  it("round-trips through an independent decryptor", () => {
    const receiver = makeReceiver();
    const message = JSON.stringify({ type: "test", title: "Smart Garage", body: "Hällo wörld", url: "/" });
    const body = encryptPayload(Buffer.from(message), receiver.subscription);
    expect(decrypt(body, receiver).toString("utf8")).toBe(message);
    // A fresh salt and ephemeral key each time: identical input never yields identical output.
    expect(encryptPayload(Buffer.from(message), receiver.subscription).equals(body)).toBe(false);
  });

  it("refuses oversized payloads and malformed keys", () => {
    const receiver = makeReceiver();
    expect(() => encryptPayload(Buffer.alloc(4000), receiver.subscription)).toThrow(/too large/);
    expect(validateSubscriptionKeys(receiver.subscription)).toEqual({ ok: true });
    expect(validateSubscriptionKeys({ p256dh: "AAAA", auth: receiver.subscription.auth }).ok).toBe(false);
    expect(validateSubscriptionKeys({ p256dh: receiver.subscription.p256dh, auth: "AAAA" }).ok).toBe(false);
    const offCurve = Buffer.concat([Buffer.from([0x04]), randomBytes(64)]).toString("base64url");
    expect(validateSubscriptionKeys({ p256dh: offCurve, auth: receiver.subscription.auth }).ok).toBe(false);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT for the endpoint's origin that verifies with the public key", () => {
    const keys = generateVapidKeys();
    const header = createVapidAuthorization("https://ntfy.sh/upabc?up=1", keys, "mailto:ops@example.com", 1_700_000_000_000);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt, k] = match!;
    expect(k).toBe(keys.publicKey);

    const [h, c, s] = jwt!.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toEqual({ aud: "https://ntfy.sh", exp: 1_700_000_000 + 12 * 3600, sub: "mailto:ops@example.com" });

    const point = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
      format: "jwk",
    });
    const signature = Buffer.from(s!, "base64url");
    expect(signature.length).toBe(64);
    expect(createVerify("SHA256").update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });
});

describe("sendWebPush", () => {
  it("POSTs aes128gcm ciphertext with VAPID, TTL and Urgency headers", async () => {
    const receiver = makeReceiver();
    const keys = generateVapidKeys();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const subscription = { endpoint: "https://ntfy.sh/upabc?up=1", ...receiver.subscription };

    const result = await sendWebPush(subscription, '{"type":"test"}', { keys, subject: "https://example.com" }, { ttl: 3600, urgency: "high", fetchImpl });
    expect(result).toEqual({ ok: true, status: 201 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(subscription.endpoint);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers.TTL).toBe("3600");
    expect(headers.Urgency).toBe("high");
    expect(headers.Authorization).toMatch(/^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{87}$/);
    const body = Buffer.from(init.body as Uint8Array);
    expect(headers["Content-Length"]).toBe(String(body.length));
    expect(body.includes(Buffer.from("test"))).toBe(false);
    expect(decrypt(body, receiver).toString()).toBe('{"type":"test"}');
  });

  it("reports gone subscriptions and keeps other failures retryable", async () => {
    const receiver = makeReceiver();
    const keys = generateVapidKeys();
    const subscription = { endpoint: "https://ntfy.sh/upabc?up=1", ...receiver.subscription };
    const vapid = { keys, subject: "https://example.com" };

    for (const status of [404, 410]) {
      const result = await sendWebPush(subscription, "x", vapid, { fetchImpl: async () => new Response("gone", { status }) });
      expect(result).toMatchObject({ ok: false, status, gone: true });
    }
    const busy = await sendWebPush(subscription, "x", vapid, { fetchImpl: async () => new Response("", { status: 507 }) });
    expect(busy).toMatchObject({ ok: false, status: 507, gone: false });
    const network = await sendWebPush(subscription, "x", vapid, {
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(network).toMatchObject({ ok: false, status: null, gone: false, error: "ECONNRESET" });
  });
});
