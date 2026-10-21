import { beforeAll, describe, expect, it } from "vitest";
import {
  listAccessibleVehicleIds,
  resolveVehicleAccess,
} from "@/lib/vehicles/access";
import {
  findAccessibleVehicle,
  listAccessibleVehicles,
} from "@/lib/repositories/vehicles";
import {
  createUser,
  createVehicle,
  shareVehicle,
} from "@/test/integration/factories";

describe("vehicle access isolation", () => {
  let owner: { id: string };
  let viewer: { id: string };
  let editor: { id: string };
  let stranger: { id: string };
  let vehicleId: string;
  let deletedVehicleId: string;

  beforeAll(async () => {
    [owner, viewer, editor, stranger] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
      createUser(),
    ]);
    vehicleId = (await createVehicle(owner.id)).id;
    deletedVehicleId = (
      await createVehicle(owner.id, { deletedAt: new Date() })
    ).id;
    await shareVehicle(vehicleId, viewer.id, "VIEWER");
    await shareVehicle(vehicleId, editor.id, "EDITOR");
  });

  it("gives the owner full access", async () => {
    expect(await resolveVehicleAccess(owner.id, vehicleId)).toMatchObject({
      role: "OWNER",
      canEdit: true,
    });
  });

  it("gives a viewer read-only access", async () => {
    expect(await resolveVehicleAccess(viewer.id, vehicleId)).toMatchObject({
      role: "VIEWER",
      canEdit: false,
    });
  });

  it("gives an editor write access", async () => {
    expect(await resolveVehicleAccess(editor.id, vehicleId)).toMatchObject({
      role: "EDITOR",
      canEdit: true,
    });
  });

  it("gives an unrelated user no access", async () => {
    expect(await resolveVehicleAccess(stranger.id, vehicleId)).toBeNull();
    expect(await findAccessibleVehicle(vehicleId, stranger.id)).toBeNull();
    expect(await listAccessibleVehicles(stranger.id)).toEqual([]);
    expect(await listAccessibleVehicleIds(stranger.id)).toEqual([]);
  });

  it("hides soft-deleted vehicles, even from the owner", async () => {
    expect(await resolveVehicleAccess(owner.id, deletedVehicleId)).toBeNull();
    const ids = (await listAccessibleVehicles(owner.id)).map((v) => v.id);
    expect(ids).toEqual([vehicleId]);
  });

  it("lists shared vehicles for viewers and editors", async () => {
    expect(await listAccessibleVehicleIds(viewer.id)).toEqual([vehicleId]);
    expect(await listAccessibleVehicleIds(editor.id)).toEqual([vehicleId]);
  });
});
