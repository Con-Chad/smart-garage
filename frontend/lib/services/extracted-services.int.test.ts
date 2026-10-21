import { beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const actor = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth/current-user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/current-user")>()),
  getCurrentUserId: async () => actor.userId,
}));

import { prisma } from "@/lib/prisma";
import { saveInspectionForCurrentUser, deleteInspectionForCurrentUser } from "@/lib/services/inspections";
import {
  createInsurancePolicyForCurrentUser,
  updateInsurancePolicyForCurrentUser,
} from "@/lib/services/insurance";
import {
  createWishlistItemForCurrentUser,
  updateWishlistItemForCurrentUser,
  deleteWishlistItemForCurrentUser,
} from "@/lib/services/wishlist";
import {
  createCustomFieldForCurrentUser,
  saveCustomFieldValuesForCurrentUser,
  TooManyCustomFieldsError,
} from "@/lib/services/custom-fields";
import {
  createModificationForCurrentUser,
  deleteModificationForCurrentUser,
} from "@/lib/services/modifications";
import { shareVehicleForCurrentUser, updateShareRoleForCurrentUser } from "@/lib/services/sharing";
import { MAX_CUSTOM_FIELDS_PER_USER } from "@/lib/domain/custom-fields";
import { createUser, createVehicle, shareVehicle } from "@/test/integration/factories";

async function zodCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZodError) return error.issues[0]?.message;
    throw error;
  }
  return "no error";
}

describe("services extracted from server actions", () => {
  let owner: { id: string; username: string };
  let editor: { id: string };
  let viewer: { id: string };
  let vehicleId: string;

  beforeAll(async () => {
    [owner, editor, viewer] = await Promise.all([createUser(), createUser(), createUser()]);
    vehicleId = (await createVehicle(owner.id)).id;
    await shareVehicle(vehicleId, editor.id, "EDITOR");
    await shareVehicle(vehicleId, viewer.id, "VIEWER");
  });

  it("inspections: validate, allow editors, refuse viewers", async () => {
    actor.userId = editor.id;
    expect(await zodCode(saveInspectionForCurrentUser(vehicleId, { type: "XX", nextDueAt: "2027-01-01" }))).toBe("invalidType");
    expect(await zodCode(saveInspectionForCurrentUser(vehicleId, { type: "HU", nextDueAt: "" }))).toBe("invalidDate");
    const saved = await saveInspectionForCurrentUser(vehicleId, { type: "HU", nextDueAt: "2027-01-01" });
    expect(saved?.reminderWeeksBefore).toBe(4);

    actor.userId = viewer.id;
    expect(await saveInspectionForCurrentUser(vehicleId, { type: "AU", nextDueAt: "2027-01-01" })).toBeNull();
    expect(await deleteInspectionForCurrentUser(saved!.id)).toBe(false);
  });

  it("insurance: validates the coverage enum that used to be cast blindly", async () => {
    actor.userId = owner.id;
    const base = { provider: "State Farm", premiumCents: 90000, startDate: "2026-01-01", endDate: "2026-12-31" };
    expect(await zodCode(createInsurancePolicyForCurrentUser(vehicleId, { ...base, provider: " " }))).toBe("providerRequired");
    expect(await zodCode(createInsurancePolicyForCurrentUser(vehicleId, { ...base, premiumCents: -1 }))).toBe("premiumInvalid");
    await expect(createInsurancePolicyForCurrentUser(vehicleId, { ...base, coverageType: "BOGUS" })).rejects.toThrow(ZodError);
    const policy = await createInsurancePolicyForCurrentUser(vehicleId, base);
    expect(policy).toMatchObject({ coverageType: "LIABILITY", premiumCents: BigInt(90000) });

    actor.userId = viewer.id;
    expect(await updateInsurancePolicyForCurrentUser(policy!.id, base)).toBeNull();
  });

  it("wishlist: private per user, and links only to visible vehicles", async () => {
    actor.userId = viewer.id;
    const item = await createWishlistItemForCurrentUser({ title: "Rack", vehicleId, estimatedCostCents: 25000 });
    expect(item.estimatedCostCents).toBe(BigInt(25000));
    expect(await zodCode(createWishlistItemForCurrentUser({ title: "" }))).toBe("titleRequired");

    const stranger = await createUser();
    actor.userId = stranger.id;
    await expect(createWishlistItemForCurrentUser({ title: "x", vehicleId })).rejects.toThrow("VEHICLE_NOT_FOUND");
    expect(await updateWishlistItemForCurrentUser(item.id, { status: "DONE" })).toBe(false);
    expect(await deleteWishlistItemForCurrentUser(item.id)).toBe(false);

    actor.userId = viewer.id;
    expect(await updateWishlistItemForCurrentUser(item.id, { status: "DONE" })).toBe(true);
  });

  it("custom fields: limit per user; editors fill in the owner's fields", async () => {
    actor.userId = owner.id;
    const field = await createCustomFieldForCurrentUser({ label: "Tire size", fieldType: "NOPE" });
    expect(field.fieldType).toBe("TEXT");

    actor.userId = editor.id;
    expect(await saveCustomFieldValuesForCurrentUser(vehicleId, { [field.id]: "225/65R17" })).toBe(true);
    actor.userId = viewer.id;
    expect(await saveCustomFieldValuesForCurrentUser(vehicleId, { [field.id]: "x" })).toBe(false);
    const value = await prisma.vehicleCustomFieldValue.findFirstOrThrow({ where: { fieldId: field.id } });
    expect(value.value).toBe("225/65R17");

    const busy = await createUser();
    actor.userId = busy.id;
    for (let i = 0; i < MAX_CUSTOM_FIELDS_PER_USER; i++) {
      await createCustomFieldForCurrentUser({ label: `f${i}` });
    }
    await expect(createCustomFieldForCurrentUser({ label: "one more" })).rejects.toThrow(TooManyCustomFieldsError);
  });

  it("modifications: editors may change them, viewers may not", async () => {
    actor.userId = editor.id;
    const mod = await createModificationForCurrentUser(vehicleId, { category: "WHEELS", name: "Winter set", costCents: 80000 });
    expect(mod?.costCents).toBe(BigInt(80000));
    actor.userId = viewer.id;
    expect(await createModificationForCurrentUser(vehicleId, { category: "WHEELS", name: "x" })).toBeNull();
    expect(await deleteModificationForCurrentUser(vehicleId, mod!.id)).toBe(false);
  });

  it("sharing: owner only, with a validated role", async () => {
    const friend = await createUser();
    actor.userId = editor.id;
    expect(await shareVehicleForCurrentUser(vehicleId, { username: friend.username })).toEqual({ error: "vehicleNotFound" });
    actor.userId = owner.id;
    await expect(shareVehicleForCurrentUser(vehicleId, { username: friend.username, role: "ADMIN" })).rejects.toThrow(ZodError);
    const result = await shareVehicleForCurrentUser(vehicleId, { username: friend.username });
    const share = "share" in result ? result.share : undefined;
    if (!share) throw new Error("expected a share");
    expect(share.role).toBe("VIEWER");
    expect(await updateShareRoleForCurrentUser(share.id, "EDITOR")).toBe(true);
    await expect(updateShareRoleForCurrentUser(share.id, "OWNER")).rejects.toThrow(ZodError);
  });
});
