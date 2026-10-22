import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { API_VERSION, apiError, apiJson, readJsonBody } from "@/lib/api/v1/http";
import { verifyCredentials } from "@/lib/services/auth";
import { DeviceLimitReachedError, createApiDevice } from "@/lib/repositories/api-devices";
import {
  LoginRateLimitedError,
  assertLoginAllowed,
  clientAddressFromHeaders,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/auth/login-throttle";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
  deviceName: z.string().trim().max(80).optional(),
});

/**
 * Exchanges a username/password for a long-lived device token. The token is
 * returned once; only its hash is stored. Failed attempts share the web
 * login's rate limit.
 */
export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return apiError(400, "invalid_request", "Expected JSON with username and password");
  }

  const { username, password, deviceName } = parsed.data;
  const address = clientAddressFromHeaders(request.headers);

  try {
    assertLoginAllowed(address, username);
  } catch (error) {
    if (error instanceof LoginRateLimitedError) {
      return apiError(429, "rate_limited", "Too many failed sign-in attempts", {
        headers: { "retry-after": String(error.retryAfterSeconds) },
      });
    }
    throw error;
  }

  let user;
  try {
    user = await verifyCredentials({ username, password });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_CREDENTIALS") {
      recordLoginFailure(address, username);
      return apiError(401, "invalid_credentials", "Invalid username or password");
    }
    throw error;
  }
  recordLoginSuccess(address, username);

  let device, token;
  try {
    ({ device, token } = await createApiDevice({
      userId: user.id,
      name: deviceName || "Mobile device",
      userAgent: request.headers.get("user-agent"),
    }));
  } catch (error) {
    if (error instanceof DeviceLimitReachedError) {
      return apiError(
        409,
        "device_limit_reached",
        `This account already has ${error.limit} active devices; revoke one under Settings → Mobile devices and sign in again`,
      );
    }
    throw error;
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return apiJson(
    {
      token,
      device,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
      apiVersion: API_VERSION,
    },
    { status: 201 },
  );
}
