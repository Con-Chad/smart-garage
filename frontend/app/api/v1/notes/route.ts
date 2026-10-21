import { listRoute } from "@/lib/api/v1/collection";
import { createNote } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = listRoute("notes");
export const POST = createNote;
