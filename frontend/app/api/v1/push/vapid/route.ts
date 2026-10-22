import { apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { getOrCreateVapidKeys } from "@/lib/notifications/push/vapid";

export const dynamic = "force-dynamic";

/**
 * The server's VAPID public key (RFC 8292), which the app passes to its
 * UnifiedPush distributor when registering. Generated on first call and
 * stable afterwards; a change means every device must re-register.
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;
  const keys = await getOrCreateVapidKeys();
  return apiJson({ publicKey: keys.publicKey, algorithm: "ES256", curve: "P-256" });
}
