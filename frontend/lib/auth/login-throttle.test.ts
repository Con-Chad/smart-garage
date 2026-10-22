import { beforeEach, describe, expect, it } from "vitest";
import {
  LoginRateLimitedError,
  assertLoginAllowed,
  clientAddressFromHeaders,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottleForTests,
} from "./login-throttle";

describe("login throttle", () => {
  beforeEach(() => resetLoginThrottleForTests());

  it("locks an account after 5 failures from one address", () => {
    for (let i = 0; i < 5; i++) {
      assertLoginAllowed("203.0.113.1", "alice");
      recordLoginFailure("203.0.113.1", "alice");
    }
    expect(() => assertLoginAllowed("203.0.113.1", "alice")).toThrow(LoginRateLimitedError);
    // Another account from the same address is still fine (spray limit is 20).
    expect(() => assertLoginAllowed("203.0.113.1", "bob")).not.toThrow();
  });

  it("locks a username after 30 failures even when every attempt forges a new address (S-2)", () => {
    for (let i = 0; i < 30; i++) {
      const address = `198.51.100.${i}`;
      assertLoginAllowed(address, "Alice ");
      recordLoginFailure(address, "alice");
    }
    expect(() => assertLoginAllowed("198.51.100.250", "alice")).toThrow(LoginRateLimitedError);
    expect(() => assertLoginAllowed("198.51.100.250", "ALICE")).toThrow(LoginRateLimitedError);
    // Only that username is affected.
    expect(() => assertLoginAllowed("198.51.100.250", "bob")).not.toThrow();
  });

  it("clears the account's counters on a correct password", () => {
    for (let i = 0; i < 29; i++) recordLoginFailure(`198.51.100.${i}`, "alice");
    recordLoginFailure("198.51.100.1", "alice");
    expect(() => assertLoginAllowed("198.51.100.1", "alice")).toThrow(LoginRateLimitedError);
    recordLoginSuccess("198.51.100.1", "alice");
    expect(() => assertLoginAllowed("198.51.100.1", "alice")).not.toThrow();
  });

  it("reads the client address from the usual proxy headers", () => {
    expect(clientAddressFromHeaders(new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
    expect(clientAddressFromHeaders(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientAddressFromHeaders(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientAddressFromHeaders(new Headers())).toBe("unknown");
  });
});
