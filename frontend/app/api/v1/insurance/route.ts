import { listRoute } from "@/lib/api/v1/collection";
import { createInsurance } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("insurancePolicies");
export const POST = createInsurance;
