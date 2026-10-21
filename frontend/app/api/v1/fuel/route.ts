import { listRoute } from "@/lib/api/v1/collection";
import { createFuel } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("fuelEntries");
export const POST = createFuel;
