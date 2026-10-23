import { z } from "zod";
import { MAINTENANCE_ITEM_CATEGORIES } from "@/lib/maintenance/item-categories";
import { MAINTENANCE_TEMPLATE_SEEDS } from "@/lib/maintenance/templates-data";
import {
  parseJsonText,
  ReceiptExtractionError,
  requestVisionJson,
  type ClaudeVisionExtractorOptions,
  type ReceiptImage,
} from "@/lib/receipts/extract";

/**
 * Service / workshop receipt extraction (D-044). Same provider call as the
 * fuel scanner (`requestVisionJson`), different prompt and schema: the model
 * reads a workshop invoice, parts receipt or other vehicle bill and maps the
 * work done to the server's maintenance template slugs. Conversion to stored
 * units and matching against the vehicle's schedules happen in
 * `service-draft.ts`.
 */

/** Template slugs the model may name (`MAINTENANCE_TEMPLATE_SEEDS`, static). */
export const SERVICE_TYPE_SLUGS = MAINTENANCE_TEMPLATE_SEEDS.map((t) => t.slug) as [string, ...string[]];

/** Expense categories a non-fuel receipt can fall into (`ExpenseCategory` minus FUEL). */
export const SERVICE_EXPENSE_CATEGORIES = [
  "MAINTENANCE",
  "REPAIR",
  "ACCESSORY",
  "INSURANCE",
  "TAX",
  "REGISTRATION",
  "OTHER",
] as const;

export const LINE_KINDS = ["part", "fluid", "labour", "fee", "discount", "other"] as const;
export const LINE_UNITS = ["l", "ml", "qt", "gal", "fl_oz", "pcs", "set", "kg", "g", "lb", "oz"] as const;

const confidence = z.number().min(0).max(1).catch(0);
const optionalText = (max: number) => z.string().trim().max(max).nullable().catch(null);
const amount = z.number().finite().nullable().catch(null);

const lineSchema = z.object({
  description: z.string().trim().max(200),
  kind: z.enum(LINE_KINDS).catch("other"),
  itemCategory: z
    .enum(MAINTENANCE_ITEM_CATEGORIES as [string, ...string[]])
    .nullable()
    .catch(null),
  brand: optionalText(120),
  partNumber: optionalText(80),
  quantity: z.number().finite().nullable().catch(null),
  unit: z.enum(LINE_UNITS).nullable().catch(null),
  total: amount,
});

/** Exactly the model-output schema in RECEIPT-SCANNER.md ("Service receipts"); validated before use. */
export const modelServiceReceiptSchema = z.object({
  isVehicleReceipt: z.boolean(),
  isFuelReceipt: z.boolean(),
  expenseCategory: z.enum(SERVICE_EXPENSE_CATEGORIES).nullable().catch(null),
  vendorName: optionalText(200),
  vendorAddress: optionalText(300),
  invoiceNumber: optionalText(80),
  /** Local date (and time) printed, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`, no zone. */
  serviceDate: z.string().trim().nullable(),
  odometer: z
    .object({ value: z.number().finite(), unit: z.enum(["km", "mi"]) })
    .nullable()
    .catch(null),
  serviceTypes: z
    .array(z.object({ slug: z.string(), confidence }))
    .max(40)
    .catch([])
    .transform((list) => list.filter((entry) => (SERVICE_TYPE_SLUGS as string[]).includes(entry.slug))),
  lineItems: z.array(lineSchema).max(80).catch([]),
  labour: amount,
  parts: amount,
  tax: amount,
  total: amount,
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z]{3}$/))
    .nullable()
    .catch(null),
  notes: optionalText(1000),
  confidence: z
    .object({
      serviceDate: confidence,
      odometer: confidence,
      total: confidence,
      vendorName: confidence,
      serviceTypes: confidence,
    })
    .partial()
    .catch({}),
});

export type ModelServiceReceipt = z.infer<typeof modelServiceReceiptSchema>;

export interface ServiceReceiptExtractor {
  readonly model: string;
  extract(image: ReceiptImage, options?: { signal?: AbortSignal }): Promise<ModelServiceReceipt>;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const nullableNumber = nullable({ type: "number" });
const nullableString = nullable({ type: "string" });

/** JSON Schema for `output_config.format` (no numeric/string constraints: not supported there). */
export const SERVICE_RECEIPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    isVehicleReceipt: { type: "boolean" },
    isFuelReceipt: { type: "boolean" },
    expenseCategory: nullable({ type: "string", enum: [...SERVICE_EXPENSE_CATEGORIES] }),
    vendorName: nullableString,
    vendorAddress: nullableString,
    invoiceNumber: nullableString,
    serviceDate: nullableString,
    odometer: nullable({
      type: "object",
      properties: { value: { type: "number" }, unit: { type: "string", enum: ["km", "mi"] } },
      required: ["value", "unit"],
      additionalProperties: false,
    }),
    serviceTypes: {
      type: "array",
      items: {
        type: "object",
        properties: { slug: { type: "string", enum: SERVICE_TYPE_SLUGS }, confidence: { type: "number" } },
        required: ["slug", "confidence"],
        additionalProperties: false,
      },
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          kind: { type: "string", enum: [...LINE_KINDS] },
          itemCategory: nullable({ type: "string", enum: MAINTENANCE_ITEM_CATEGORIES }),
          brand: nullableString,
          partNumber: nullableString,
          quantity: nullableNumber,
          unit: nullable({ type: "string", enum: [...LINE_UNITS] }),
          total: nullableNumber,
        },
        required: ["description", "kind", "itemCategory", "brand", "partNumber", "quantity", "unit", "total"],
        additionalProperties: false,
      },
    },
    labour: nullableNumber,
    parts: nullableNumber,
    tax: nullableNumber,
    total: nullableNumber,
    currency: nullableString,
    notes: nullableString,
    confidence: {
      type: "object",
      properties: {
        serviceDate: { type: "number" },
        odometer: { type: "number" },
        total: { type: "number" },
        vendorName: { type: "number" },
        serviceTypes: { type: "number" },
      },
      required: ["serviceDate", "odometer", "total", "vendorName", "serviceTypes"],
      additionalProperties: false,
    },
  },
  required: [
    "isVehicleReceipt",
    "isFuelReceipt",
    "expenseCategory",
    "vendorName",
    "vendorAddress",
    "invoiceNumber",
    "serviceDate",
    "odometer",
    "serviceTypes",
    "lineItems",
    "labour",
    "parts",
    "tax",
    "total",
    "currency",
    "notes",
    "confidence",
  ],
  additionalProperties: false,
} as const;

const SERVICE_TYPE_LIST = MAINTENANCE_TEMPLATE_SEEDS.map((t) => `- ${t.slug}: ${t.nameEn}`).join("\n");

export const SERVICE_SYSTEM_PROMPT = `You read photos of vehicle service and expense receipts (workshop invoices, repair bills, parts and tyre receipts, inspection certificates with a fee, registration, tax or insurance bills) for a vehicle logbook.

Respond with ONLY a JSON object matching the given schema, no prose, no markdown fences.

Rules:
- isVehicleReceipt is false when the image is not a bill or receipt for a vehicle (a grocery receipt, a random photo). isFuelReceipt is true when it is a fuel or EV charging purchase. Still fill in what you can see.
- expenseCategory: MAINTENANCE for scheduled servicing (oil change, inspection, filters, fluids, tyres changed or rotated), REPAIR for fixing a fault or damage, ACCESSORY for accessories and add-ons, INSURANCE, TAX, REGISTRATION for those bills, OTHER for anything else.
- Use null for anything that is missing or illegible. Never guess digits.
- Numbers are plain decimals with "." as the decimal separator, no thousands separators, no currency symbols. Receipts from Germany and most of Europe print "," as the decimal separator; convert it.
- Money amounts are in the receipt's currency units (e.g. 129.90), not cents. total is the final amount payable including tax. labour, parts and tax are the subtotals if printed (labour = "Arbeitslohn"/"Labor", parts = "Teile"/"Material"); otherwise null.
- currency is the ISO 4217 code inferred from symbols, wording and country ("€" EUR, "$" USD unless the receipt shows CAD/AUD/NZD, "£" GBP, "CHF", "kr" SEK/NOK/DKK by country, "zł" PLN, "Kč" CZK).
- serviceDate is the date the work was done (else the invoice date) as "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM:SS" if a time is printed, without a timezone. Infer day/month order from the receipt's country and language.
- odometer is the vehicle mileage printed on the invoice ("km-Stand", "Mileage", "Odometer"), with unit "km" or "mi"; null when not printed.
- serviceTypes lists the maintenance types the work covers, using only these slugs (omit work that matches none):
${SERVICE_TYPE_LIST}
- lineItems lists each printed line: description as printed; kind "part", "fluid", "labour", "fee", "discount" or "other"; itemCategory one of ${MAINTENANCE_ITEM_CATEGORIES.join(", ")} for parts and fluids (null for labour and fees); brand and partNumber if printed; quantity and unit ("l", "ml", "qt", "gal", "fl_oz", "pcs", "set", "kg", "g", "lb", "oz") if printed; total is the line amount as printed (negative for discounts).
- notes: workshop recommendations or advisories printed on the invoice (e.g. "rear brake pads at 3 mm"), else null. Never include card numbers or personal data.
- confidence is 0 to 1 per field: 1 when crisp and unambiguous, lower when faded, cut off or inferred; 0 when the field is null or empty.`;

const SERVICE_USER_PROMPT = "Extract this vehicle service receipt.";

/** Validates the model's text as a service receipt; tolerates stray code fences. */
export function parseServiceModelJson(text: string): ModelServiceReceipt {
  const result = modelServiceReceiptSchema.safeParse(parseJsonText(text));
  if (!result.success) {
    throw new ReceiptExtractionError(
      "invalid_output",
      "The vision provider's JSON did not match the service receipt schema",
    );
  }
  return result.data;
}

export function claudeServiceReceiptExtractor(options: ClaudeVisionExtractorOptions): ServiceReceiptExtractor {
  const spec = { system: SERVICE_SYSTEM_PROMPT, userText: SERVICE_USER_PROMPT, schema: SERVICE_RECEIPT_JSON_SCHEMA };
  return {
    model: options.model,
    async extract(image, extractOptions) {
      return parseServiceModelJson(await requestVisionJson(options, spec, image, extractOptions?.signal));
    },
  };
}
