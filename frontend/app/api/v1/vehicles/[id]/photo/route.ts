import { uploadVehiclePhoto } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

/** Multipart upload replacing the vehicle photo (field "file"). */
export const POST = uploadVehiclePhoto;
