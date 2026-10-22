import { z } from "zod";

/**
 * Receipt extraction (fork: con-chad/smart-garage, D-012/D-042).
 *
 * `ReceiptExtractor` turns a receipt photo into the model-output JSON from
 * `docs/mobile/RECEIPT-SCANNER.md`, nothing more: no unit conversion, no
 * database access. `lib/receipts/draft.ts` converts that into a fill-up
 * draft in stored units. The interface exists so an on-device or local-OCR
 * extractor can replace the Claude one without touching the endpoint.
 */

export type ReceiptImage = {
  bytes: Uint8Array;
  /** One of the image types the vision API accepts: JPEG, PNG, WebP, GIF. */
  mimeType: string;
};

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code"))
  .nullable();

const money = z
  .object({
    value: z.number().finite(),
    currency: currencyCode,
  })
  .nullable();

const confidence = z.number().min(0).max(1).catch(0);

/** Exactly the model-output schema in the design doc; validated before any use. */
export const modelReceiptSchema = z.object({
  isFuelReceipt: z.boolean(),
  stationName: z.string().trim().max(200).nullable(),
  stationAddress: z.string().trim().max(300).nullable(),
  /** Local date/time printed on the receipt, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`, no zone. */
  purchasedAt: z.string().trim().nullable(),
  volume: z
    .object({
      value: z.number().finite(),
      unit: z.enum(["l", "gal", "imp_gal"]),
    })
    .nullable(),
  pricePerUnit: money,
  total: money,
  fuelGrade: z.string().trim().max(80).nullable(),
  confidence: z
    .object({
      volume: confidence,
      total: confidence,
      purchasedAt: confidence,
      pricePerUnit: confidence,
      stationName: confidence,
    })
    .partial()
    .catch({}),
});

export type ModelReceipt = z.infer<typeof modelReceiptSchema>;

export interface ReceiptExtractor {
  /** Identifier recorded with every scan (`ReceiptScan.model`). */
  readonly model: string;
  extract(image: ReceiptImage, options?: { signal?: AbortSignal }): Promise<ModelReceipt>;
}

export type ReceiptExtractionErrorKind =
  /** The provider answered with a non-2xx status or the network failed. */
  | "provider"
  | "timeout"
  /** 2xx, but the body wasn't the JSON object we asked for. */
  | "invalid_output"
  /** The model declined to look at the image. */
  | "refusal"
  /** Output cut off by `max_tokens`. */
  | "truncated"
  /** Larger than the provider accepts; the caller should answer 413. */
  | "image_too_large";

/**
 * Carries only what the endpoint may show: the kind and, for provider
 * errors, the HTTP status. Never the provider's body, never the key.
 */
export class ReceiptExtractionError extends Error {
  constructor(
    readonly kind: ReceiptExtractionErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ReceiptExtractionError";
  }
}

// ─── Claude vision implementation ────────────────────────────────────────────

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** The Claude API accepts images up to 10 MB base64-encoded (vision docs). */
export const PROVIDER_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 25_000;
/**
 * The answer is a few hundred tokens of JSON; this also bounds the adaptive
 * thinking the current models do before answering.
 */
const MAX_TOKENS = 4096;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const moneySchema = nullable({
  type: "object",
  properties: {
    value: { type: "number" },
    currency: nullable({ type: "string" }),
  },
  required: ["value", "currency"],
  additionalProperties: false,
});

/** JSON Schema for `output_config.format` (no numeric/string constraints: not supported there). */
export const RECEIPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    isFuelReceipt: { type: "boolean" },
    stationName: nullable({ type: "string" }),
    stationAddress: nullable({ type: "string" }),
    purchasedAt: nullable({ type: "string" }),
    volume: nullable({
      type: "object",
      properties: {
        value: { type: "number" },
        unit: { type: "string", enum: ["l", "gal", "imp_gal"] },
      },
      required: ["value", "unit"],
      additionalProperties: false,
    }),
    pricePerUnit: moneySchema,
    total: moneySchema,
    fuelGrade: nullable({ type: "string" }),
    confidence: {
      type: "object",
      properties: {
        volume: { type: "number" },
        total: { type: "number" },
        purchasedAt: { type: "number" },
        pricePerUnit: { type: "number" },
        stationName: { type: "number" },
      },
      required: ["volume", "total", "purchasedAt", "pricePerUnit", "stationName"],
      additionalProperties: false,
    },
  },
  required: [
    "isFuelReceipt",
    "stationName",
    "stationAddress",
    "purchasedAt",
    "volume",
    "pricePerUnit",
    "total",
    "fuelGrade",
    "confidence",
  ],
  additionalProperties: false,
} as const;

export const SYSTEM_PROMPT = `You read photos of fuel receipts (petrol, diesel, LPG, CNG, EV charging) for a vehicle logbook.

Respond with ONLY a JSON object of this exact shape, no prose, no markdown fences:
{"isFuelReceipt": boolean, "stationName": string|null, "stationAddress": string|null, "purchasedAt": string|null, "volume": {"value": number, "unit": "l"|"gal"|"imp_gal"}|null, "pricePerUnit": {"value": number, "currency": string|null}|null, "total": {"value": number, "currency": string|null}|null, "fuelGrade": string|null, "confidence": {"volume": number, "total": number, "purchasedAt": number, "pricePerUnit": number, "stationName": number}}

Rules:
- isFuelReceipt is false when the image is not a receipt for a fuel or charging purchase (a shop receipt, a car wash, a random photo). Still fill in what you can see.
- Use null for anything that is missing or illegible. Never guess digits.
- Numbers are plain decimals with "." as the decimal separator, no thousands separators, no currency symbols. Receipts from Germany and most of Europe print "," as the decimal separator; convert it.
- volume is the fuel quantity actually dispensed. unit: "l" for litres, "gal" for US gallons, "imp_gal" for imperial gallons.
- pricePerUnit is the price per litre or per gallon as printed, in the same unit as volume. total is the amount paid for the fuel (before loyalty discounts are fine; exclude shop items if they are listed separately).
- currency is the ISO 4217 code inferred from symbols, wording and country ("€" EUR, "$" USD unless the receipt shows CAD/AUD/NZD, "£" GBP, "CHF", "kr" SEK/NOK/DKK by country, "zł" PLN, "Kč" CZK).
- purchasedAt is the local date and time printed on the receipt as "YYYY-MM-DDTHH:MM:SS" (or "YYYY-MM-DD" when no time is printed), without a timezone. Infer day/month order from the receipt's country and language (DD.MM.YYYY in Germany, MM/DD/YYYY in the US).
- confidence is 0 to 1 per field: 1 when crisp and unambiguous, lower when faded, cut off or inferred; 0 when the field is null.`;

const USER_PROMPT = "Extract this fuel receipt.";

export type ClaudeVisionExtractorOptions = {
  apiKey: string;
  model: string;
  /** `output_config.effort`; null leaves the model's default. */
  effort?: string | null;
  timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  endpoint?: string;
};

/**
 * Plain `fetch` to the Messages API, no SDK: one request shape, one
 * response shape, and no new dependency on a server that otherwise never
 * calls out.
 */
export function claudeVisionExtractor(options: ClaudeVisionExtractorOptions): ReceiptExtractor {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
  const endpoint = options.endpoint ?? ANTHROPIC_MESSAGES_URL;

  return {
    model: options.model,
    async extract(image, extractOptions) {
      const data = Buffer.from(image.bytes).toString("base64");
      if (data.length > PROVIDER_MAX_IMAGE_BASE64_BYTES) {
        throw new ReceiptExtractionError("image_too_large", "The image exceeds the provider's 10 MB limit");
      }

      const body = {
        model: options.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: {
          ...(options.effort ? { effort: options.effort } : {}),
          format: { type: "json_schema", schema: RECEIPT_JSON_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mimeType, data } },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onOuterAbort = () => controller.abort();
      extractOptions?.signal?.addEventListener("abort", onOuterAbort, { once: true });

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new ReceiptExtractionError("timeout", `The vision provider did not answer within ${timeoutMs} ms`);
        }
        throw new ReceiptExtractionError("provider", "Could not reach the vision provider");
      } finally {
        clearTimeout(timer);
        extractOptions?.signal?.removeEventListener("abort", onOuterAbort);
      }

      if (!response.ok) {
        // Log the status and error type only; the body is never forwarded.
        const type = await providerErrorType(response);
        console.warn(`[receipt-scanner] provider responded ${response.status}${type ? ` (${type})` : ""}`);
        throw new ReceiptExtractionError("provider", "The vision provider rejected the request", response.status);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ReceiptExtractionError("invalid_output", "The vision provider returned a non-JSON body");
      }
      return parseMessagesResponse(payload);
    },
  };
}

async function providerErrorType(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.json()) as { error?: { type?: unknown } };
    return typeof parsed?.error?.type === "string" ? parsed.error.type : null;
  } catch {
    return null;
  }
}

const messagesResponseSchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
});

/** Validates a Messages API response and the JSON object inside it. */
export function parseMessagesResponse(payload: unknown): ModelReceipt {
  const parsed = messagesResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ReceiptExtractionError("invalid_output", "Unexpected response shape from the vision provider");
  }
  if (parsed.data.stop_reason === "refusal") {
    throw new ReceiptExtractionError("refusal", "The vision provider declined to process this image");
  }
  if (parsed.data.stop_reason === "max_tokens") {
    throw new ReceiptExtractionError("truncated", "The vision provider's answer was cut off");
  }

  const text = parsed.data.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  return parseModelJson(text);
}

/** Parses the model's text as the receipt object; tolerates stray code fences. */
export function parseModelJson(text: string): ModelReceipt {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(unfenced);
  } catch {
    throw new ReceiptExtractionError("invalid_output", "The vision provider did not return JSON");
  }
  const result = modelReceiptSchema.safeParse(json);
  if (!result.success) {
    throw new ReceiptExtractionError("invalid_output", "The vision provider's JSON did not match the receipt schema");
  }
  return result.data;
}
