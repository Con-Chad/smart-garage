import { itemRoute } from "@/lib/api/v1/collection";
import { updateVehicle, deleteVehicle } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("vehicles");
export const PATCH = updateVehicle;
export const DELETE = deleteVehicle;
