import { prisma } from "@/lib/prisma";
import { apiError, apiJson } from "@/lib/api/v1/http";
import { ApiProblem, assertCanEditVehicle, handleWrite, parseMultipart } from "@/lib/api/v1/write";
import { receiptScannerConfig, type ReceiptScannerConfig } from "@/lib/receipts/config";
import { buildReceiptDraft } from "@/lib/receipts/draft";
import {
  claudeVisionExtractor,
  PROVIDER_MAX_IMAGE_BASE64_BYTES,
  ReceiptExtractionError,
  type ReceiptExtractor,
} from "@/lib/receipts/extract";
import { releaseScanSlot, reserveScanSlot, secondsUntilNextUtcDay } from "@/lib/receipts/quota";
import { createVehicleFileDocument } from "@/lib/repositories/documents";
import { findPreferencesForUser } from "@/lib/repositories/preferences";
import { saveVehicleDocument } from "@/lib/storage/local";
import { ALLOWED_IMAGE_MIME_TYPES, getMaxImageSizeBytes } from "@/lib/storage/paths";
import { sniffMimeType } from "@/lib/storage/sniff";

/**
 * `POST /api/v1/fuel/receipt-scan` (D-012/D-042): multipart `file` +
 * `vehicleId`. Saves the photo as a RECEIPT document on the vehicle, asks the
 * extractor for the receipt's values and returns a draft fill-up. Nothing is
 * written to `FuelEntry`; the app posts the confirmed values to
 * `POST /api/v1/fuel` with `receiptDocumentId` to link the two.
 *
 * Order of checks: device token (401) → feature on (404, D-030: a disabled
 * feature is indistinguishable from a missing route) → multipart (415/400) →
 * vehicle visible and editable (404/403) → image type and size (415/413) →
 * daily limit (429, reserved atomically before anything is saved or billed,
 * see `reserveScanSlot`) → save → extract (502 on provider trouble).
 */

/**
 * Raw bytes allowed for a receipt photo. Base64 grows the payload by a third,
 * and the provider accepts 10 MB encoded, so this stays under that even when
 * MAX_IMAGE_SIZE_MB is set higher. The app sends ~1600 px JPEGs, far below.
 */
export const RECEIPT_MAX_IMAGE_BYTES = Math.floor((PROVIDER_MAX_IMAGE_BASE64_BYTES / 4) * 3) - 1024;

export type ReceiptScanDeps = {
  /** Replaces the Claude extractor (tests, future on-device/OCR backends). */
  extractor?: ReceiptExtractor;
  config?: () => ReceiptScannerConfig;
  now?: () => Date;
};

export function createReceiptScanHandler(deps: ReceiptScanDeps = {}) {
  const readConfig = deps.config ?? (() => receiptScannerConfig());
  const now = deps.now ?? (() => new Date());

  return (request: Request): Promise<Response> =>
    handleWrite(request, async (ctx) => {
      const config = readConfig();
      if (!config.enabled) throw new ApiProblem(404, "not_found", "Not found");

      const form = await parseMultipart(ctx.request);
      const vehicleId = form.get("vehicleId");
      if (typeof vehicleId !== "string" || vehicleId === "" || vehicleId.length > 64) {
        throw new ApiProblem(422, "validation_failed", "Send the vehicle id in a multipart field named \"vehicleId\"");
      }
      assertCanEditVehicle(ctx.scope, vehicleId);

      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        throw new ApiProblem(422, "validation_failed", "Send the photo in a multipart field named \"file\"");
      }
      const maxBytes = Math.min(RECEIPT_MAX_IMAGE_BYTES, getMaxImageSizeBytes());
      if (file.size > maxBytes) {
        throw new ApiProblem(413, "file_too_large", `Receipt photos are limited to ${Math.floor(maxBytes / 1024 / 1024)} MB`);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniffMimeType(bytes);
      if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type) || sniffed !== file.type) {
        throw new ApiProblem(
          415,
          "unsupported_file_type",
          "Send a JPEG, PNG, WebP or GIF photo whose content matches its type; PDFs are not scanned",
        );
      }

      const at = now();
      const slot = await reserveScanSlot({ userId: ctx.user.id, vehicleId, limit: config.dailyLimit, now: at });
      if (!slot) {
        return apiError(
          429,
          "rate_limited",
          `The receipt scanner allows ${config.dailyLimit} scans per day; try again tomorrow (UTC)`,
          { headers: { "retry-after": String(secondsUntilNextUtcDay(at)) } },
        );
      }

      const extractor =
        deps.extractor ??
        claudeVisionExtractor({ apiKey: config.apiKey ?? "", model: config.model, effort: config.effort });

      let document: { id: string };
      try {
        const saved = await saveVehicleDocument(vehicleId, file);
        document = await createVehicleFileDocument({
          vehicleId,
          uploadedByUserId: ctx.user.id,
          file: saved,
          purpose: "RECEIPT",
        });
        await prisma.receiptScan.update({
          where: { id: slot.id },
          data: { documentId: document.id, model: extractor.model },
        });
      } catch (error) {
        // Nothing was sent to the provider, so the slot goes back.
        await releaseScanSlot(slot.id).catch(() => {});
        throw error;
      }
      const finish = (outcome: string) =>
        prisma.receiptScan.update({ where: { id: slot.id }, data: { outcome } });

      let raw;
      try {
        raw = await extractor.extract({ bytes, mimeType: sniffed });
      } catch (error) {
        await finish("failed");
        if (error instanceof ReceiptExtractionError) {
          if (error.kind === "image_too_large") {
            throw new ApiProblem(413, "file_too_large", error.message);
          }
          console.warn(`[receipt-scanner] extraction failed: ${error.kind}${error.status ? ` (${error.status})` : ""}`);
          // The photo is saved either way; the app can attach it without a draft.
          return apiJson(
            { error: { code: "extraction_failed", message: userMessageFor(error) }, documentId: document.id },
            { status: 502 },
          );
        }
        throw error;
      }

      const preferences = await findPreferencesForUser(ctx.user.id);
      const result = buildReceiptDraft(raw, { fallbackCurrency: preferences.currency ?? null, now: at });
      await finish(result.isFuelReceipt ? "ok" : "not_fuel_receipt");

      return apiJson({
        documentId: document.id,
        isFuelReceipt: result.isFuelReceipt,
        draft: result.draft,
        warnings: result.warnings,
        model: extractor.model,
        scansRemainingToday: Math.max(0, config.dailyLimit - slot.used),
      });
    });
}

function userMessageFor(error: ReceiptExtractionError): string {
  switch (error.kind) {
    case "timeout":
      return "The receipt scanner took too long; try again";
    case "refusal":
      return "The receipt scanner declined this image";
    case "truncated":
    case "invalid_output":
      return "The receipt scanner returned an unreadable answer; try again";
    default:
      return "The receipt scanner is unavailable right now; try again later";
  }
}

/** Route handler with the real configuration and the Claude extractor. */
export const scanFuelReceipt = createReceiptScanHandler();
