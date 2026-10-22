import { afterEach, describe, expect, it } from "vitest";
import {
  checkPushEndpointSyntax,
  isPrivateAddress,
  validatePushEndpoint,
} from "@/lib/notifications/push/endpoint-guard";

const publicDns = async () => ["104.16.1.1", "2606:4700::1"];

describe("push endpoint guard", () => {
  afterEach(() => {
    delete process.env.UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS;
  });

  it("accepts public https distributors such as ntfy.sh", async () => {
    for (const endpoint of [
      "https://ntfy.sh/upAbC123xyz?up=1",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl",
      "https://push.example.org:443/path",
    ]) {
      const result = await validatePushEndpoint(endpoint, publicDns);
      expect(result.ok, endpoint).toBe(true);
    }
  });

  it("rejects anything that is not plain https on the default port", () => {
    const cases: Record<string, string> = {
      "http://ntfy.sh/topic": "https",
      "https://ntfy.sh:8443/topic": "default https port",
      "https://user:pw@ntfy.sh/topic": "credentials",
      "ftp://ntfy.sh/topic": "https",
      "https://ntfy.sh/topic#frag": "fragment",
      "not-a-url": "valid URL",
      "https://ntfy.sh/to pic": "whitespace",
      "": "required",
    };
    for (const [endpoint, reason] of Object.entries(cases)) {
      const result = checkPushEndpointSyntax(endpoint);
      expect(result.ok, endpoint).toBe(false);
      if (!result.ok) expect(result.reason).toContain(reason);
    }
  });

  it("rejects literal private, loopback, link-local, CGNAT and metadata addresses", () => {
    for (const host of [
      "10.0.0.5",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.3.4",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "[fd12::1]",
      "[fe80::1]",
      "[::ffff:10.0.0.1]",
      "[64:ff9b::7f00:1]",
      "localhost",
      "ntfy.local",
      "metadata.google.internal",
      "ntfy",
    ]) {
      expect(checkPushEndpointSyntax(`https://${host}/topic`).ok, host).toBe(false);
    }
  });

  it("rejects hosts that resolve to a private address (DNS rebinding)", async () => {
    const result = await validatePushEndpoint("https://evil.example/topic", async () => ["93.184.216.34", "127.0.0.1"]);
    expect(result).toEqual({ ok: false, reason: "endpoint resolves to a private address" });

    const unresolved = await validatePushEndpoint("https://nope.example/topic", async () => []);
    expect(unresolved.ok).toBe(false);

    const failing = await validatePushEndpoint("https://nope.example/topic", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(failing.ok).toBe(false);
  });

  it("classifies addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1")).toBe(false);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("2001:db8::1")).toBe(true);
    expect(isPrivateAddress("2002:0a00:0001::")).toBe(true);
    expect(isPrivateAddress("garbage")).toBe(true);
  });

  it("lets a self-hoster opt in to private endpoints, but still requires https", async () => {
    process.env.UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS = "true";
    expect((await validatePushEndpoint("https://ntfy.lan:8443/topic", async () => ["192.168.1.20"])).ok).toBe(true);
    expect((await validatePushEndpoint("https://192.168.1.20/topic")).ok).toBe(true);
    expect((await validatePushEndpoint("http://192.168.1.20/topic")).ok).toBe(false);
  });
});
