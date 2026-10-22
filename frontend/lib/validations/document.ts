import { z } from "zod";
import { DocumentCategory } from "@prisma/client";

export const uploadDocumentSchema = z.object({
  vehicleId: z.string().min(1).max(64),
  category: z
    .string()
    .optional()
    .nullable()
    .transform((value) => {
      if (!value) return null;
      return z.nativeEnum(DocumentCategory).parse(value);
    }),
  title: z.string().trim().max(120).optional().nullable(),
  maintenanceRecordId: z.string().max(64).optional().nullable(),
});

export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
