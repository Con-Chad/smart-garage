import { afterEach, describe, expect, it, vi } from "vitest";

// registerUser sets the session cookie through `next/headers`; stand in for
// Next's request scope so the service can run outside a request.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { prisma } from "@/lib/prisma";
import { isRegistrationOpen, registerUser } from "@/lib/services/auth";

const PASSWORD = "correct horse battery";

describe("self-registration gate (S-3)", () => {
  afterEach(() => {
    delete process.env.REGISTRATION_ENABLED;
  });

  it("lets the first account in as admin, then closes without REGISTRATION_ENABLED", async () => {
    expect(await prisma.user.count()).toBe(0);
    expect(await isRegistrationOpen()).toBe(true);

    const first = await registerUser({ username: "first", password: PASSWORD });
    expect(first.role).toBe("ADMIN");

    expect(await isRegistrationOpen()).toBe(false);
    await expect(registerUser({ username: "second", password: PASSWORD })).rejects.toThrow("REGISTRATION_CLOSED");
    // A closed server reveals nothing about existing names either.
    await expect(registerUser({ username: "first", password: PASSWORD })).rejects.toThrow("REGISTRATION_CLOSED");
    expect(await prisma.user.count()).toBe(1);
  });

  it("accepts further accounts as plain users while REGISTRATION_ENABLED=true", async () => {
    process.env.REGISTRATION_ENABLED = "true";
    expect(await isRegistrationOpen()).toBe(true);

    const second = await registerUser({ username: "second", password: PASSWORD });
    expect(second.role).toBe("USER");
    await expect(registerUser({ username: "second", password: PASSWORD })).rejects.toThrow("USERNAME_TAKEN");

    process.env.REGISTRATION_ENABLED = "false";
    await expect(registerUser({ username: "third", password: PASSWORD })).rejects.toThrow("REGISTRATION_CLOSED");
    expect(await prisma.user.count()).toBe(2);
  });
});
