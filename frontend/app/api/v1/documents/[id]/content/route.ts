import { NextResponse } from "next/server";
import { apiError, requireApiAuth } from "@/lib/api/v1/http";
import { getDocumentForDownload } from "@/lib/services/documents";
import { readStoredFile } from "@/lib/storage/local";
import { isViewableInline } from "@/lib/storage/paths";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * File bytes for a document or vehicle photo the user can see. Same access
 * rule as the web download route; `?download=1` forces an attachment.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const document = await getDocumentForDownload(id, auth.user.id);
  if (!document) return apiError(404, "not_found", "Not found");

  let buffer: Buffer;
  try {
    buffer = await readStoredFile(document.storageKey);
  } catch {
    return apiError(404, "file_missing", "The stored file is missing");
  }

  const forceDownload = new URL(request.url).searchParams.get("download") === "1";
  const inline = !forceDownload && isViewableInline(document.mimeType);
  const filename = encodeURIComponent(document.originalFilename);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": document.mimeType,
      "Content-Length": String(buffer.length),
      // Documents never change once uploaded (a replacement gets a new id).
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
    },
  });
}
