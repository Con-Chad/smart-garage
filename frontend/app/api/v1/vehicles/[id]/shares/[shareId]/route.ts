import { updateShare, deleteShare } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

/** Change a share's role or remove it. Owner only. */
export const PATCH = updateShare;
export const DELETE = deleteShare;
