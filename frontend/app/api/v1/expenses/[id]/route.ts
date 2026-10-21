import { itemRoute } from "@/lib/api/v1/collection";
import { deleteExpenseEntry } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("expenses");
export const DELETE = deleteExpenseEntry;
