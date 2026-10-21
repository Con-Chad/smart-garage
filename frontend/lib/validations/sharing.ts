import { VehicleShareRole } from "@prisma/client";
import { z } from "zod";

export const shareRoleSchema = z.nativeEnum(VehicleShareRole, { error: "invalidRole" });

export const shareVehicleInputSchema = z.object({
  username: z.string({ error: "userNotFound" }).trim().min(1, "userNotFound").max(80),
  role: shareRoleSchema.default("VIEWER"),
});

export type ShareVehicleInputData = z.infer<typeof shareVehicleInputSchema>;
