import { putCustomFieldValues } from "@/lib/api/v1/mutations";

export const dynamic = "force-dynamic";

/** Sets custom-field values on a vehicle: `{ "values": { fieldId: value } }`. */
export const PUT = putCustomFieldValues;
