import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  claudeVisionExtractor,
  parseModelJson,
  ReceiptExtractionError,
  type ModelReceipt,
} from "@/lib/receipts/extract";

const receipt: ModelReceipt = {
  isFuelReceipt: true,
  stationName: "Shell",
  stationAddress: "123 Main St, Springfield",
  purchasedAt: "2026-10-20T14:32:00",
  volume: { value: 11.482, unit: "gal" },
  pricePerUnit: { value: 3.459, currency: "USD" },
  total: { value: 39.72, currency: "USD" },
  fuelGrade: "Regular 87",
  confidence: { volume: 0.98, total: 0.99, purchasedAt: 0.9, pricePerUnit: 0.95, stationName: 0.9 },
};

const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" };

function messagesResponse(text: string, stopReason = "end_turn", status = 200) {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      stop_reason: stopReason,
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text },
      ],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function expectKind(promise: Promise<unknown>, kind: ReceiptExtractionError["kind"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ReceiptExtractionError);
  expect((error as ReceiptExtractionError).kind).toBe(kind);
  return error as ReceiptExtractionError;
}

describe("claudeVisionExtractor", () => {
  it("sends one Messages request with the image, the schema and no SDK", async () => {
    const fetchMock = vi.fn(async () => messagesResponse(JSON.stringify(receipt)));
    const extractor = claudeVisionExtractor({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5-5",
      effort: "low",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await extractor.extract(image);
    expect(result).toEqual(receipt);
    expect(extractor.model).toBe("claude-sonnet-5-5");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.max_tokens).toBeLessThanOrEqual(4096);
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.system).toMatch(/ONLY a JSON object/);
    expect(body.messages).toHaveLength(1);
    const [imageBlock, textBlock] = body.messages[0].content;
    expect(imageBlock).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(image.bytes).toString("base64") },
    });
    expect(textBlock.type).toBe("text");
    // Sampling parameters are rejected on current models; make sure none sneak in.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
  });

  it("omits effort when not configured", async () => {
    const fetchMock = vi.fn(async () => messagesResponse(JSON.stringify(receipt)));
    await claudeVisionExtractor({ apiKey: "k", model: "m", effort: null, fetch: fetchMock as unknown as typeof fetch }).extract(image);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.output_config).not.toHaveProperty("effort");
  });

  it("tolerates a fenced JSON answer", async () => {
    const fetchMock = vi.fn(async () => messagesResponse("```json\n" + JSON.stringify(receipt) + "\n```"));
    const result = await claudeVisionExtractor({ apiKey: "k", model: "m", fetch: fetchMock as unknown as typeof fetch }).extract(image);
    expect(result.total).toEqual({ value: 39.72, currency: "USD" });
  });

  it("maps a provider error to kind=provider without leaking the body or key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key: sk-ant-secret" } }), {
            status: 401,
          }),
      );
      const error = await expectKind(
        claudeVisionExtractor({ apiKey: "sk-ant-secret", model: "m", fetch: fetchMock as unknown as typeof fetch }).extract(image),
        "provider",
      );
      expect(error.status).toBe(401);
      expect(error.message).not.toContain("sk-ant-secret");
      expect(error.message).not.toContain("invalid x-api-key");
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("401");
      expect(logged).not.toContain("sk-ant-secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("maps a network failure to kind=provider", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expectKind(claudeVisionExtractor({ apiKey: "k", model: "m", fetch: fetchMock as unknown as typeof fetch }).extract(image), "provider");
  });

  it("aborts after the timeout and reports kind=timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await expectKind(
      claudeVisionExtractor({ apiKey: "k", model: "m", timeoutMs: 10, fetch: fetchMock as unknown as typeof fetch }).extract(image),
      "timeout",
    );
  });

  it("reports a refusal and a cut-off answer distinctly", async () => {
    const refused = vi.fn(async () => messagesResponse("", "refusal"));
    await expectKind(claudeVisionExtractor({ apiKey: "k", model: "m", fetch: refused as unknown as typeof fetch }).extract(image), "refusal");

    const truncated = vi.fn(async () => messagesResponse('{"isFuelReceipt": tr', "max_tokens"));
    await expectKind(claudeVisionExtractor({ apiKey: "k", model: "m", fetch: truncated as unknown as typeof fetch }).extract(image), "truncated");
  });

  it("rejects an answer that isn't the receipt schema", async () => {
    const prose = vi.fn(async () => messagesResponse("Sure! Here is the receipt: total 39.72"));
    await expectKind(claudeVisionExtractor({ apiKey: "k", model: "m", fetch: prose as unknown as typeof fetch }).extract(image), "invalid_output");

    const wrongShape = vi.fn(async () => messagesResponse(JSON.stringify({ ...receipt, volume: { value: "eleven", unit: "gal" } })));
    await expectKind(
      claudeVisionExtractor({ apiKey: "k", model: "m", fetch: wrongShape as unknown as typeof fetch }).extract(image),
      "invalid_output",
    );
  });

  it("refuses images the provider would reject as too large, before calling it", async () => {
    const fetchMock = vi.fn();
    const huge = { bytes: new Uint8Array(8 * 1024 * 1024), mimeType: "image/png" };
    await expectKind(claudeVisionExtractor({ apiKey: "k", model: "m", fetch: fetchMock as unknown as typeof fetch }).extract(huge), "image_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseModelJson", () => {
  it("normalizes currency codes and clamps confidence", () => {
    const parsed = parseModelJson(
      JSON.stringify({
        ...receipt,
        total: { value: 39.72, currency: " usd " },
        confidence: { volume: 1.7, total: -1, purchasedAt: "high" },
      }),
    );
    expect(parsed.total?.currency).toBe("USD");
    expect(parsed.confidence).toEqual({ volume: 0, total: 0, purchasedAt: 0 });
  });

  it("rejects a currency that isn't a three-letter code", () => {
    expect(() => parseModelJson(JSON.stringify({ ...receipt, total: { value: 1, currency: "dollars" } }))).toThrow(
      ReceiptExtractionError,
    );
  });

  it("accepts the not-a-receipt answer with nulls", () => {
    const parsed = parseModelJson(
      JSON.stringify({
        isFuelReceipt: false,
        stationName: null,
        stationAddress: null,
        purchasedAt: null,
        volume: null,
        pricePerUnit: null,
        total: null,
        fuelGrade: null,
        confidence: { volume: 0, total: 0, purchasedAt: 0, pricePerUnit: 0, stationName: 0 },
      }),
    );
    expect(parsed.isFuelReceipt).toBe(false);
  });
});
