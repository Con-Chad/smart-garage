import { describe, expect, it } from "vitest";
import { odometerCreateSchema } from "@/lib/api/v1/schemas";

describe("odometerCreateSchema source (D-046)", () => {
  const base = { vehicleId: "v1", odometerKm: 1000 };

  it("defaults to manual", () => {
    expect(odometerCreateSchema.parse(base).source).toBe("manual");
  });

  it("accepts manual and obd", () => {
    expect(odometerCreateSchema.parse({ ...base, source: "manual" }).source).toBe("manual");
    expect(odometerCreateSchema.parse({ ...base, source: "obd" }).source).toBe("obd");
  });

  it("rejects other sources, including the server-only wican", () => {
    expect(odometerCreateSchema.safeParse({ ...base, source: "wican" }).success).toBe(false);
    expect(odometerCreateSchema.safeParse({ ...base, source: "" }).success).toBe(false);
    expect(odometerCreateSchema.safeParse({ ...base, source: 1 }).success).toBe(false);
  });
});
