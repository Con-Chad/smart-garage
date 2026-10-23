import { scanServiceReceipt } from "@/lib/receipts/scan";

export const dynamic = "force-dynamic";

/**
 * Multipart upload (`file`, `vehicleId`) of a service / workshop / vehicle
 * expense receipt (D-044). Saves it as a RECEIPT document and returns a
 * maintenance-record draft; nothing is written to MaintenanceRecord or
 * Expense. 404 while the scanner is disabled (RECEIPT_SCANNER_ENABLED).
 */
export const POST = scanServiceReceipt;
