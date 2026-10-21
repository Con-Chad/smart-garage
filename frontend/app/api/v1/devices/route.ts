import { apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { listApiDevicesForUser } from "@/lib/repositories/api-devices";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const devices = await listApiDevicesForUser(auth.user.id);
  return apiJson({
    devices: devices.map((device) => ({
      ...device,
      current: device.id === auth.device?.id,
    })),
  });
}
