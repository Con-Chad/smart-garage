import { itemRoute } from "@/lib/api/v1/collection";
import { updateNote, deleteNote } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

export const GET = itemRoute("notes");
export const PATCH = updateNote;
export const DELETE = deleteNote;
