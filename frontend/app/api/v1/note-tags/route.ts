import { apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { listTagsForOwner } from "@/lib/repositories/notes";

export const dynamic = "force-dynamic";

/** The user's note tags, alphabetically. Small, so never paginated. */
export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;
  return apiJson({ items: await listTagsForOwner(auth.user.id) });
}
