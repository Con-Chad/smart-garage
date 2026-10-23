import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION, ReceiptExtractionError } from "@/lib/receipts/extract";
import {
  claudeServiceReceiptExtractor,
  parseServiceModelJson,
  SERVICE_TYPE_SLUGS,
} from "@/lib/receipts/service-extract";
import { workshopReceipt } from "@/test/fixtures/service-receipt";

const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" };

function messagesResponse(text: string, stopReason = "end_turn", status = 200) {
  return new Response(
    JSON.stringify({ id: "msg_1", type: "message", stop_reason: stopReason, content: [{ type: "text", text }] }),
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
}

describe("claudeServiceReceiptExtractor", () => {
  it("sends one Messages request with the image and the service schema", async () => {
    const fetchMock = vi.fn(async () => messagesResponse(JSON.stringify(workshopReceipt)));
    const extractor = claudeServiceReceiptExtractor({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5-5",
      effort: "low",
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(await extractor.extract(image)).toEqual(workshopReceipt);
    expect(extractor.model).toBe("claude-sonnet-5-5");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);

    const body = JSON.parse(init.body as string);
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    const schema = body.output_config.format.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.serviceTypes.items.properties.slug.enum).toEqual(SERVICE_TYPE_SLUGS);
    expect(body.system).toMatch(/ONLY a JSON object/);
    expect(body.system).toContain("oil_change");
    expect(body.messages[0].content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg" },
    });
    expect(body.messages[0].content[1].text).toMatch(/service receipt/);
  });

  it("maps provider failures to the same error kinds as the fuel scanner, without leaking the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = claudeServiceReceiptExtractor({
      apiKey: "sk-ant-secret",
      model: "m",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { type: "overloaded_error", message: "sk-ant-secret" } }), {
          status: 529,
        })) as unknown as typeof fetch,
    });
    await expectKind(failing.extract(image), "provider");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-ant-secret");
    warn.mockRestore();

    const refusal = claudeServiceReceiptExtractor({
      apiKey: "k",
      model: "m",
      fetch: (async () => messagesResponse("", "refusal")) as unknown as typeof fetch,
    });
    await expectKind(refusal.extract(image), "refusal");

    const truncated = claudeServiceReceiptExtractor({
      apiKey: "k",
      model: "m",
      fetch: (async () => messagesResponse("{", "max_tokens")) as unknown as typeof fetch,
    });
    await expectKind(truncated.extract(image), "truncated");

    const garbage = claudeServiceReceiptExtractor({
      apiKey: "k",
      model: "m",
      fetch: (async () => messagesResponse(JSON.stringify({ isFuelReceipt: true }))) as unknown as typeof fetch,
    });
    await expectKind(garbage.extract(image), "invalid_output");
  });
});

describe("parseServiceModelJson", () => {
  it("tolerates code fences and drops unknown service-type slugs and bad optional values", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        ...workshopReceipt,
        serviceTypes: [
          { slug: "oil_change", confidence: 0.9 },
          { slug: "flux_capacitor", confidence: 1 },
        ],
        currency: "euro",
        lineItems: [{ ...workshopReceipt.lineItems[0], kind: "mystery", unit: "barrels" }],
      }) +
      "\n```";
    const parsed = parseServiceModelJson(text);
    expect(parsed.serviceTypes).toEqual([{ slug: "oil_change", confidence: 0.9 }]);
    expect(parsed.currency).toBeNull();
    expect(parsed.lineItems[0]).toMatchObject({ kind: "other", unit: null });
  });

  it("rejects non-JSON and objects without the required flags", () => {
    expect(() => parseServiceModelJson("not json")).toThrow(ReceiptExtractionError);
    expect(() => parseServiceModelJson(JSON.stringify({ vendorName: "x" }))).toThrow(ReceiptExtractionError);
  });
});
