import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api/v1/http";

/**
 * `Idempotency-Key` support for API writes (D-023). The app's offline outbox
 * sends a UUID per queued write; if the connection drops after the server
 * applied it, the retry gets the stored response instead of a duplicate.
 *
 * - First request: a placeholder row reserves the key, the handler runs, and
 *   its response (any status below 500) is stored.
 * - Retry with the same key and request: the stored response is replayed
 *   with `Idempotent-Replayed: true`.
 * - Same key, different method/path/body: 422, the key was reused by mistake.
 * - Same key while the first attempt is still running: 409, retry shortly.
 * - 5xx or a thrown error releases the key so the retry runs for real.
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A placeholder older than this belongs to a request that died mid-flight. */
const STALE_IN_FLIGHT_MS = 2 * 60 * 1000;

export async function withIdempotency(
  request: Request,
  userId: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (key == null) return handler();
  if (!KEY_PATTERN.test(key)) {
    return apiError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-128 characters of [A-Za-z0-9_.:-]");
  }

  const fingerprint = await fingerprintRequest(request);
  void pruneIdempotencyKeys().catch(() => {
    // Housekeeping only.
  });

  const reserved = await reserve(userId, key, fingerprint);
  if (reserved instanceof Response) return reserved;

  let response: Response;
  try {
    response = await handler();
  } catch (error) {
    await release(reserved);
    throw error;
  }

  if (response.status >= 500) {
    await release(reserved);
    return response;
  }

  const body = await response.clone().text();
  await prisma.apiIdempotencyKey.update({
    where: { id: reserved },
    data: { status: response.status, responseBody: body, completedAt: new Date() },
  });
  return response;
}

async function reserve(userId: string, key: string, fingerprint: string): Promise<string | Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await prisma.apiIdempotencyKey.create({
        data: { userId, key, fingerprint },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
    }

    const existing = await prisma.apiIdempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing) continue; // released between our insert and read; try again

    if (existing.fingerprint !== fingerprint) {
      return apiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was already used for a different request",
      );
    }
    if (existing.status == null) {
      if (Date.now() - existing.createdAt.getTime() > STALE_IN_FLIGHT_MS) {
        await prisma.apiIdempotencyKey.deleteMany({ where: { id: existing.id, status: null } });
        continue;
      }
      return apiError(409, "request_in_progress", "The original request is still being processed", {
        headers: { "retry-after": "1" },
      });
    }
    return replay(existing.status, existing.responseBody ?? "");
  }
  return apiError(409, "request_in_progress", "Could not reserve the Idempotency-Key; retry", {
    headers: { "retry-after": "1" },
  });
}

function replay(status: number, body: string): Response {
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : body, {
    status,
    headers: {
      ...(noBody ? {} : { "content-type": "application/json; charset=utf-8" }),
      "cache-control": "no-store",
      "idempotent-replayed": "true",
    },
  });
}

async function release(id: string) {
  await prisma.apiIdempotencyKey.delete({ where: { id } }).catch(() => {
    // Already gone; nothing to release.
  });
}

async function fingerprintRequest(request: Request): Promise<string> {
  const hash = createHash("sha256");
  hash.update(request.method.toUpperCase());
  hash.update("\0");
  hash.update(new URL(request.url).pathname);
  hash.update("\0");
  // The body is hashed from a clone so the handler can still read the original.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    // Clients pick a fresh random boundary per attempt, so hash the parts
    // rather than the raw bytes.
    const form = await request.clone().formData();
    const entries = [...form.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, value] of entries) {
      hash.update(`${name}\0`);
      if (typeof value === "string") {
        hash.update(`s\0${value}\0`);
      } else {
        hash.update(`f\0${value.name}\0${value.type}\0`);
        hash.update(Buffer.from(await value.arrayBuffer()));
        hash.update("\0");
      }
    }
  } else {
    hash.update(Buffer.from(await request.clone().arrayBuffer()));
  }
  return hash.digest("hex");
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneState = globalThis as unknown as { idempotencyKeysPrunedAt?: number };

async function pruneIdempotencyKeys(now = Date.now()) {
  if (now - (pruneState.idempotencyKeysPrunedAt ?? 0) < PRUNE_INTERVAL_MS) return;
  pruneState.idempotencyKeysPrunedAt = now;
  await prisma.apiIdempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(now - RETENTION_MS) } },
  });
}
