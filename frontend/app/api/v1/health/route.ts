import { API_VERSION, apiJson } from "@/lib/api/v1/http";
import { checkDatabaseConnection } from "@/lib/repositories/database";
import { APP_VERSION } from "@/lib/app-version";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated connection check for API clients. Unlike `/api/health` it
 * omits the database statistics (user/vehicle counts), which an API client
 * has no use for. A JSON body with `service: "smart-garage"` lets the app tell
 * "reached Smart Garage" apart from a proxy or login page answering instead.
 */
export async function GET() {
  const connected = await checkDatabaseConnection();
  return apiJson(
    {
      service: "smart-garage",
      status: connected ? "ok" : "error",
      version: APP_VERSION,
      apiVersion: API_VERSION,
      database: connected ? "connected" : "disconnected",
    },
    { status: connected ? 200 : 503 },
  );
}
