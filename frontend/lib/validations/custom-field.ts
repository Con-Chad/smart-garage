import { z } from "zod";
import {
  CUSTOM_FIELD_TYPES,
  MAX_CUSTOM_FIELD_LABEL_LENGTH,
  MAX_CUSTOM_FIELD_VALUE_LENGTH,
} from "@/lib/domain/custom-fields";

export const customFieldInputSchema = z.object({
  label: z
    .string({ error: "labelRequired" })
    .trim()
    .min(1, "labelRequired")
    .max(MAX_CUSTOM_FIELD_LABEL_LENGTH, "labelTooLong"),
  // Unknown types fall back to TEXT, as the web form always did.
  fieldType: z.enum(CUSTOM_FIELD_TYPES).catch("TEXT"),
  unit: z.string().trim().max(20).nullable().optional(),
});

/** Field id → value for one vehicle; an empty string clears the value. */
export const customFieldValuesSchema = z.record(
  z.string().min(1),
  z.string().max(MAX_CUSTOM_FIELD_VALUE_LENGTH),
);

export type CustomFieldInputData = z.infer<typeof customFieldInputSchema>;
