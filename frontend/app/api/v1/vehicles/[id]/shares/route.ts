import { apiError, apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { resolveVehicleAccess } from "@/lib/vehicles/access";
import { listSharesForVehicle } from "@/lib/repositories/vehicle-shares";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Who a vehicle is shared with. Owner only, like the web sharing panel. */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const access = await resolveVehicleAccess(auth.user.id, id);
  if (!access) return apiError(404, "not_found", "Not found");
  if (access.role !== "OWNER") {
    return apiError(403, "forbidden", "Only the owner can see who a vehicle is shared with");
  }

  const shares = await listSharesForVehicle(id, auth.user.id);
  return apiJson({
    items: shares.map((share) => ({
      id: share.id,
      role: share.role,
      user: share.user,
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
    })),
  });
}
