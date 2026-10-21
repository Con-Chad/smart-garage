import { listRoute } from "@/lib/api/v1/collection";
import { createExpenseEntry } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("expenses");
export const POST = createExpenseEntry;
