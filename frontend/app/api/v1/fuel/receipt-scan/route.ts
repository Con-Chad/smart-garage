import { scanFuelReceipt } from "@/lib/receipts/scan";

export const dynamic = "force-dynamic";

/**
 * Multipart upload (`file`, `vehicleId`) of a fuel receipt photo. Saves it
 * as a RECEIPT document and returns a fill-up draft; nothing is written to
 * FuelEntry. 404 while the scanner is disabled (RECEIPT_SCANNER_ENABLED).
 */
export const POST = scanFuelReceipt;
