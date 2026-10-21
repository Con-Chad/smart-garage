import { listRoute } from "@/lib/api/v1/collection";
import { createVehicle } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("vehicles");
export const POST = createVehicle;
