import { describe, expect, it } from "vitest";
import { registrationEnabledByEnv, registrationOpenFor } from "./registration";

describe("registration gate", () => {
  it("is off unless REGISTRATION_ENABLED is truthy", () => {
    expect(registrationEnabledByEnv({})).toBe(false);
    expect(registrationEnabledByEnv({ REGISTRATION_ENABLED: "" })).toBe(false);
    expect(registrationEnabledByEnv({ REGISTRATION_ENABLED: "false" })).toBe(false);
    expect(registrationEnabledByEnv({ REGISTRATION_ENABLED: "no" })).toBe(false);
    expect(registrationEnabledByEnv({ REGISTRATION_ENABLED: "true" })).toBe(true);
    expect(registrationEnabledByEnv({ REGISTRATION_ENABLED: " TRUE " })).toBe(true);
    expect(registrationEnabledByEnv({ REGISTRATION_ENABLED: "1" })).toBe(true);
  });

  it("always lets the first account in, and later ones only when enabled", () => {
    expect(registrationOpenFor(0, {})).toBe(true);
    expect(registrationOpenFor(1, {})).toBe(false);
    expect(registrationOpenFor(7, { REGISTRATION_ENABLED: "false" })).toBe(false);
    expect(registrationOpenFor(7, { REGISTRATION_ENABLED: "true" })).toBe(true);
  });
});
