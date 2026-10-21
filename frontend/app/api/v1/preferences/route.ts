import { apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { findPreferencesForUser } from "@/lib/repositories/preferences";
import { preferencesToApi } from "@/lib/api/v1/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;
  return apiJson(preferencesToApi(await findPreferencesForUser(auth.user.id)));
}
