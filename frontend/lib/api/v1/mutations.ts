import type { z } from "zod";
import { prisma } from "@/lib/prisma";
import { apiJson } from "@/lib/api/v1/http";
import { loadApiScope } from "@/lib/api/v1/scope";
import { notificationSettingsToApi, preferencesToApi } from "@/lib/api/v1/settings";
import {
  customFieldValuesBodySchema,
  expenseCreateSchema,
  fuelCreateSchema,
  itemDefaultsSchema,
  notePatchSchema,
  noteFieldsSchema,
  notificationSettingsPatchSchema,
  odometerCreateSchema,
  passthroughSchema,
  preferencesPatchSchema,
  recordCreateSchema,
  recordPatchSchema,
  scheduleCreateSchema,
  schedulePatchSchema,
  shareCreateSchema,
  sharePatchSchema,
  vehicleCreateSchema,
  vehiclePatchSchema,
} from "@/lib/api/v1/schemas";
import {
  ApiProblem,
  assertCanEditVehicle,
  assertOwnsVehicle,
  findEditableRow,
  findVisibleRow,
  handleWrite,
  noContent,
  parseJsonBody,
  parseMultipart,
  respondWithResource,
  type WriteContext,
} from "@/lib/api/v1/write";
import { defaultsToItemInputs, serializeMaintenanceItem } from "@/lib/repositories/maintenance-items";
import {
  findNotificationSettings,
  upsertNotificationSettings,
  type NotificationSettingsRecord,
} from "@/lib/repositories/notifications";
import { findPreferencesForUser, upsertPreferencesForUser } from "@/lib/repositories/preferences";
import {
  createCustomFieldForCurrentUser,
  deleteCustomFieldForCurrentUser,
  saveCustomFieldValuesForCurrentUser,
  TooManyCustomFieldsError,
  updateCustomFieldForCurrentUser,
} from "@/lib/services/custom-fields";
import { deleteVehicleDocument, uploadVehicleDocument } from "@/lib/services/documents";
import { createExpense, deleteExpense } from "@/lib/services/expenses";
import { createFuelEntry, deleteFuelEntry } from "@/lib/services/fuel";
import {
  deleteInspectionForCurrentUser,
  saveInspectionForCurrentUser,
} from "@/lib/services/inspections";
import {
  createInsurancePolicyForCurrentUser,
  deleteInsurancePolicyForCurrentUser,
  updateInsurancePolicyForCurrentUser,
} from "@/lib/services/insurance";
import {
  clearScheduleItemDefaults,
  createMaintenanceSchedule,
  deleteMaintenanceRecordEntry,
  deleteMaintenanceSchedule,
  logMaintenanceService,
  saveScheduleItemDefaults,
  updateMaintenanceRecord,
  updateMaintenanceSchedule,
} from "@/lib/services/maintenance";
import {
  createModificationForCurrentUser,
  deleteModificationForCurrentUser,
  updateModificationForCurrentUser,
} from "@/lib/services/modifications";
import {
  createNoteForCurrentUser,
  deleteNoteForCurrentUser,
  updateNoteForCurrentUser,
} from "@/lib/services/notes";
import { deleteOdometerReading, logOdometerReading } from "@/lib/services/odometer";
import {
  removeShareForCurrentUser,
  shareVehicleForCurrentUser,
  updateShareRoleForCurrentUser,
} from "@/lib/services/sharing";
import {
  createVehicleForCurrentUser,
  deleteVehicleForCurrentUser,
  replaceVehiclePhotoForCurrentUser,
  updateVehicleDetailsForCurrentUser,
} from "@/lib/services/vehicles";
import {
  createWishlistItemForCurrentUser,
  deleteWishlistItemForCurrentUser,
  updateWishlistItemForCurrentUser,
} from "@/lib/services/wishlist";
import { uploadDocumentSchema } from "@/lib/validations/document";
import { createNoteSchema, updateNoteSchema } from "@/lib/validations/notes";
import type { MaintenanceItemInput } from "@/lib/validations/maintenance-items";

/**
 * Write handlers for `/api/v1`, one per route method. Each validates the
 * body, checks access up front (404 hidden, 403 view-only, D-030) and then
 * calls the same service the web UI's server action uses, so business rules
 * (odometer only moves forward, due-status recompute, expense from service
 * cost, notifications) can't diverge. Responses use the read (GET) shape.
 *
 * PATCH bodies are merged onto the stored row before calling services that
 * replace the whole entity. Concurrent edits: last write wins for now; the
 * conflict rule is settled in CP11 (see DECISIONS.md D-033).
 */

type IdContext = { params: Promise<{ id: string }> };
type ShareContext = { params: Promise<{ id: string; shareId: string }> };

type Handler = (request: Request) => Promise<Response>;
type IdHandler = (request: Request, context: IdContext) => Promise<Response>;

function write(run: (ctx: WriteContext) => Promise<Response>): Handler {
  return (request) => handleWrite(request, run);
}

function writeById(run: (ctx: WriteContext, id: string) => Promise<Response>): IdHandler {
  return async (request, context) => {
    const { id } = await context.params;
    return handleWrite(request, (ctx) => run(ctx, id));
  };
}

const iso = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/** Plain values of a stored row for merging a PATCH: BigInt cents become numbers. */
function pick<K extends string>(row: Record<string, unknown>, keys: readonly K[]) {
  const out = {} as Record<K, unknown>;
  for (const key of keys) {
    const value = row[key];
    out[key] = typeof value === "bigint" ? Number(value) : value;
  }
  return out;
}

/** Drops keys whose value is `undefined`, so a PATCH only overrides what it sends. */
function defined<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function jsonBody<T extends z.ZodType>(ctx: WriteContext, schema: T) {
  return parseJsonBody(ctx.request, schema);
}

// ─── Vehicles ──────────────────────────────────────────────────────────────

export const createVehicle = write(async (ctx) => {
  const body = await jsonBody(ctx, vehicleCreateSchema);
  // The web form's manual mode, in stored units (km).
  const form = new FormData();
  form.set("entryMode", "manual");
  form.set("distanceUnit", "km");
  for (const [key, value] of Object.entries(body)) {
    form.set(key, value == null ? "" : String(value));
  }
  const result = await createVehicleForCurrentUser(form);
  if (!result.success) {
    throw new ApiProblem(422, "validation_failed", result.error.field
      ? `${result.error.field}: ${result.error.code}`
      : result.error.code);
  }
  return respondWithResource(await loadApiScope(ctx.user.id), "vehicles", result.vehicleId, 201);
});

export const updateVehicle = writeById(async (ctx, id) => {
  assertCanEditVehicle(ctx.scope, id);
  const body = await jsonBody(ctx, vehiclePatchSchema);
  const { purchaseDate, ...rest } = body;
  await updateVehicleDetailsForCurrentUser(id, { ...rest, purchaseDate: iso(purchaseDate) });
  return respondWithResource(ctx.scope, "vehicles", id);
});

export const deleteVehicle = writeById(async (ctx, id) => {
  assertOwnsVehicle(ctx.scope, id);
  const result = await deleteVehicleForCurrentUser(id);
  if (!result.success) throw new ApiProblem(404, "not_found", "Not found");
  return noContent();
});

export const uploadVehiclePhoto = writeById(async (ctx, id) => {
  assertCanEditVehicle(ctx.scope, id);
  const form = await parseMultipart(ctx.request);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new ApiProblem(422, "validation_failed", "Send the image in a multipart field named \"file\"");
  }
  await replaceVehiclePhotoForCurrentUser(id, file);
  return respondWithResource(ctx.scope, "vehicles", id);
});

export const putCustomFieldValues = writeById(async (ctx, id) => {
  assertCanEditVehicle(ctx.scope, id);
  const { values } = await jsonBody(ctx, customFieldValuesBodySchema);
  await saveCustomFieldValuesForCurrentUser(id, values);
  return noContent();
});

// ─── Sharing (owner only) ──────────────────────────────────────────────────

async function shareResponse(shareId: string, status = 200) {
  const share = await prisma.vehicleShare.findUniqueOrThrow({
    where: { id: shareId },
    include: { user: { select: { id: true, username: true, displayName: true } } },
  });
  return apiJson(
    {
      id: share.id,
      role: share.role,
      user: share.user,
      createdAt: share.createdAt,
      updatedAt: share.updatedAt,
    },
    { status },
  );
}

const SHARE_ERRORS = {
  userNotFound: "No user with that username",
  selfShare: "You can't share a vehicle with yourself",
} as const;

export const createShare = writeById(async (ctx, id) => {
  assertOwnsVehicle(ctx.scope, id);
  const body = await jsonBody(ctx, shareCreateSchema);
  const result = await shareVehicleForCurrentUser(id, body);
  if (!result.share) {
    const error = result.error ?? "vehicleNotFound";
    if (error === "vehicleNotFound") throw new ApiProblem(404, "not_found", "Not found");
    throw new ApiProblem(422, error === "userNotFound" ? "user_not_found" : "self_share", SHARE_ERRORS[error]);
  }
  return shareResponse(result.share.id, 201);
});

/** The share must be on the vehicle in the path, not just any vehicle the user owns. */
async function assertShareOnVehicle(ctx: WriteContext, vehicleId: string, shareId: string) {
  assertOwnsVehicle(ctx.scope, vehicleId);
  const share = await prisma.vehicleShare.findFirst({
    where: { id: shareId, vehicleId },
    select: { id: true },
  });
  if (!share) throw new ApiProblem(404, "not_found", "Not found");
}

export async function updateShare(request: Request, context: ShareContext) {
  const { id, shareId } = await context.params;
  return handleWrite(request, async (ctx) => {
    await assertShareOnVehicle(ctx, id, shareId);
    const { role } = await jsonBody(ctx, sharePatchSchema);
    await updateShareRoleForCurrentUser(shareId, role);
    return shareResponse(shareId);
  });
}

export async function deleteShare(request: Request, context: ShareContext) {
  const { id, shareId } = await context.params;
  return handleWrite(request, async (ctx) => {
    await assertShareOnVehicle(ctx, id, shareId);
    await removeShareForCurrentUser(shareId);
    return noContent();
  });
}

// ─── Fuel, expenses, odometer ──────────────────────────────────────────────

export const createFuel = write(async (ctx) => {
  const body = await jsonBody(ctx, fuelCreateSchema);
  assertCanEditVehicle(ctx.scope, body.vehicleId);
  const id = await createFuelEntry({
    ...body,
    stationName: body.stationName ?? undefined,
    note: body.note ?? undefined,
  });
  return respondWithResource(ctx.scope, "fuelEntries", id, 201);
});

export const deleteFuel = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "fuelEntries", id);
  await deleteFuelEntry(id);
  return noContent();
});

export const createExpenseEntry = write(async (ctx) => {
  const body = await jsonBody(ctx, expenseCreateSchema);
  assertCanEditVehicle(ctx.scope, body.vehicleId);
  const id = await createExpense({
    ...body,
    maintenanceRecordId: body.maintenanceRecordId ?? undefined,
    description: body.description ?? undefined,
  });
  return respondWithResource(ctx.scope, "expenses", id, 201);
});

export const deleteExpenseEntry = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "expenses", id);
  await deleteExpense(id);
  return noContent();
});

export const createOdometerLog = write(async (ctx) => {
  const body = await jsonBody(ctx, odometerCreateSchema);
  assertCanEditVehicle(ctx.scope, body.vehicleId);
  const id = await logOdometerReading({
    vehicleId: body.vehicleId,
    odometerKm: body.odometerKm,
    recordedAt: body.recordedAt ? new Date(body.recordedAt) : undefined,
    note: body.note,
  });
  return respondWithResource(ctx.scope, "odometerLogs", id, 201);
});

export const deleteOdometerLog = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "odometerLogs", id);
  await deleteOdometerReading(id);
  return noContent();
});

// ─── Maintenance ───────────────────────────────────────────────────────────

export const createSchedule = write(async (ctx) => {
  const body = await jsonBody(ctx, scheduleCreateSchema);
  assertCanEditVehicle(ctx.scope, body.vehicleId);
  const id = await createMaintenanceSchedule({
    ...body,
    estimatedCostCents: body.estimatedCostCents,
  });
  return respondWithResource(ctx.scope, "schedules", id, 201);
});

export const updateSchedule = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "schedules", id);
  const body = await jsonBody(ctx, schedulePatchSchema);
  await updateMaintenanceSchedule({
    scheduleId: id,
    ...body,
    estimatedCostCents: body.estimatedCostCents,
    // The service treats "" as "clear the baseline".
    lastPerformedAt: body.lastPerformedAt === null ? "" : body.lastPerformedAt,
  });
  const updated = await prisma.vehicleMaintenanceSchedule.findUnique({
    where: { id },
    select: { isActive: true },
  });
  // Deactivating is the web UI's delete; the schedule is no longer listed.
  if (!updated?.isActive) return noContent();
  return respondWithResource(ctx.scope, "schedules", id);
});

/** Deactivates the schedule (the web UI's delete); its records stay. */
export const deleteSchedule = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "schedules", id);
  await deleteMaintenanceSchedule(id);
  return noContent();
});

export const putScheduleItemDefaults = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "schedules", id);
  const { items } = await jsonBody(ctx, itemDefaultsSchema);
  await saveScheduleItemDefaults({ scheduleId: id, items });
  return respondWithResource(ctx.scope, "schedules", id);
});

export const deleteScheduleItemDefaults = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "schedules", id);
  await clearScheduleItemDefaults(id);
  return respondWithResource(ctx.scope, "schedules", id);
});

export const createRecord = write(async (ctx) => {
  const { items, ...body } = await jsonBody(ctx, recordCreateSchema);
  await findEditableRow(ctx.scope, "schedules", body.scheduleId);
  const id = await logMaintenanceService(
    {
      ...body,
      costCents: body.costCents,
      vendorName: body.vendorName ?? undefined,
      note: body.note ?? undefined,
    },
    (items ?? []) as MaintenanceItemInput[],
  );
  return respondWithResource(ctx.scope, "maintenanceRecords", id, 201);
});

type RecordRow = {
  vehicleId: string;
  items: Parameters<typeof serializeMaintenanceItem>[0][];
} & Record<string, unknown>;

export const updateRecord = writeById(async (ctx, id) => {
  const row = await findEditableRow<RecordRow>(ctx.scope, "maintenanceRecords", id);
  const patch = await jsonBody(ctx, recordPatchSchema);
  // The service replaces items and clears omitted text fields, so start from
  // the stored record.
  const current = pick(row, ["performedAt", "odometerKm", "costCents", "currency", "vendorName", "note"]);
  const merged = { ...current, ...defined(patch) };
  const items =
    patch.items ?? defaultsToItemInputs(row.items.map(serializeMaintenanceItem));
  await updateMaintenanceRecord(
    {
      recordId: id,
      performedAt: new Date(merged.performedAt as string | Date).toISOString(),
      odometerKm: merged.odometerKm as number | null,
      costCents: merged.costCents as number,
      currency: merged.currency as string,
      vendorName: (merged.vendorName as string | null) ?? undefined,
      note: (merged.note as string | null) ?? undefined,
      saveAsDefault: patch.saveAsDefault,
    },
    items as MaintenanceItemInput[],
  );
  return respondWithResource(ctx.scope, "maintenanceRecords", id);
});

export const deleteRecord = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "maintenanceRecords", id);
  await deleteMaintenanceRecordEntry(id);
  return noContent();
});

// ─── Documents ─────────────────────────────────────────────────────────────

/** Multipart: `file`, `vehicleId`, optional `category`, `title`, `maintenanceRecordId`. */
export const createDocument = write(async (ctx) => {
  const form = await parseMultipart(ctx.request);
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value !== "" ? value : null;
  };
  const input = uploadDocumentSchema.parse({
    vehicleId: field("vehicleId") ?? "",
    category: field("category"),
    title: field("title"),
    maintenanceRecordId: field("maintenanceRecordId"),
  });
  assertCanEditVehicle(ctx.scope, input.vehicleId);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new ApiProblem(422, "validation_failed", "Send the file in a multipart field named \"file\"");
  }
  const id = await uploadVehicleDocument(input, file);
  return respondWithResource(ctx.scope, "documents", id, 201);
});

export const deleteDocument = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "documents", id);
  await deleteVehicleDocument(id);
  return noContent();
});

// ─── Inspections, insurance, modifications ─────────────────────────────────

/** One inspection per vehicle and type: posting again replaces it. */
export const saveInspection = write(async (ctx) => {
  const { vehicleId, ...body } = await jsonBody(ctx, passthroughSchema);
  if (typeof vehicleId !== "string") throw new ApiProblem(422, "validation_failed", "vehicleId is required");
  assertCanEditVehicle(ctx.scope, vehicleId);
  const saved = await saveInspectionForCurrentUser(vehicleId, body);
  if (!saved) throw new ApiProblem(404, "not_found", "Not found");
  return respondWithResource(ctx.scope, "inspections", saved.id);
});

export const deleteInspection = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "inspections", id);
  await deleteInspectionForCurrentUser(id);
  return noContent();
});

const INSURANCE_FIELDS = [
  "provider",
  "policyNumber",
  "premiumCents",
  "currency",
  "sfClass",
  "coverageType",
  "startDate",
  "endDate",
  "autoRenew",
  "notes",
] as const;

export const createInsurance = write(async (ctx) => {
  const { vehicleId, ...body } = await jsonBody(ctx, passthroughSchema);
  if (typeof vehicleId !== "string") throw new ApiProblem(422, "validation_failed", "vehicleId is required");
  assertCanEditVehicle(ctx.scope, vehicleId);
  const policy = await createInsurancePolicyForCurrentUser(vehicleId, body);
  if (!policy) throw new ApiProblem(404, "not_found", "Not found");
  return respondWithResource(ctx.scope, "insurancePolicies", policy.id, 201);
});

export const updateInsurance = writeById(async (ctx, id) => {
  const row = await findEditableRow<{ vehicleId: string }>(ctx.scope, "insurancePolicies", id);
  const patch = await jsonBody(ctx, passthroughSchema);
  await updateInsurancePolicyForCurrentUser(id, {
    ...pick(row, INSURANCE_FIELDS),
    ...defined(pickKnown(patch, INSURANCE_FIELDS)),
  });
  return respondWithResource(ctx.scope, "insurancePolicies", id);
});

export const deleteInsurance = writeById(async (ctx, id) => {
  await findEditableRow(ctx.scope, "insurancePolicies", id);
  await deleteInsurancePolicyForCurrentUser(id);
  return noContent();
});

const MODIFICATION_FIELDS = [
  "category",
  "name",
  "description",
  "installedAt",
  "costCents",
  "currency",
  "addedPowerKw",
  "addedPowerPs",
  "addedTorqueNm",
  "notes",
  "isCustom",
] as const;

export const createModification = write(async (ctx) => {
  const { vehicleId, ...body } = await jsonBody(ctx, passthroughSchema);
  if (typeof vehicleId !== "string") throw new ApiProblem(422, "validation_failed", "vehicleId is required");
  assertCanEditVehicle(ctx.scope, vehicleId);
  const mod = await createModificationForCurrentUser(vehicleId, body);
  if (!mod) throw new ApiProblem(404, "not_found", "Not found");
  return respondWithResource(ctx.scope, "modifications", mod.id, 201);
});

export const updateModification = writeById(async (ctx, id) => {
  const row = await findEditableRow<{ vehicleId: string }>(ctx.scope, "modifications", id);
  const patch = await jsonBody(ctx, passthroughSchema);
  await updateModificationForCurrentUser(row.vehicleId, id, {
    ...pick(row, MODIFICATION_FIELDS),
    ...defined(pickKnown(patch, MODIFICATION_FIELDS)),
  });
  return respondWithResource(ctx.scope, "modifications", id);
});

export const deleteModification = writeById(async (ctx, id) => {
  const row = await findEditableRow<{ vehicleId: string }>(ctx.scope, "modifications", id);
  await deleteModificationForCurrentUser(row.vehicleId, id);
  return noContent();
});

/** Only the listed keys of a passthrough body, so stray fields can't sneak into a merge. */
function pickKnown<K extends string>(body: Record<string, unknown>, keys: readonly K[]) {
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) if (key in body) out[key] = body[key];
  return out;
}

// ─── Custom fields (definitions belong to their creator) ───────────────────

const CUSTOM_FIELD_FIELDS = ["label", "fieldType", "unit"] as const;

function tooManyFields(error: unknown): never {
  if (error instanceof TooManyCustomFieldsError) {
    throw new ApiProblem(422, "too_many_custom_fields", "The custom field limit has been reached");
  }
  throw error;
}

export const createCustomField = write(async (ctx) => {
  const body = await jsonBody(ctx, passthroughSchema);
  const field = await createCustomFieldForCurrentUser(body).catch(tooManyFields);
  return respondWithResource(ctx.scope, "customFields", field.id, 201);
});

/** A shared vehicle's owner's fields are visible but not editable: 403. */
async function findOwnCustomField(ctx: WriteContext, id: string) {
  const row = await findVisibleRow<{ userId: string }>(ctx.scope, "customFields", id);
  if (row.userId !== ctx.user.id) {
    throw new ApiProblem(403, "forbidden", "Only the field's creator can change it");
  }
  return row;
}

export const updateCustomField = writeById(async (ctx, id) => {
  const row = await findOwnCustomField(ctx, id);
  const patch = await jsonBody(ctx, passthroughSchema);
  await updateCustomFieldForCurrentUser(id, {
    ...pick(row, CUSTOM_FIELD_FIELDS),
    ...defined(pickKnown(patch, CUSTOM_FIELD_FIELDS)),
  });
  return respondWithResource(ctx.scope, "customFields", id);
});

export const deleteCustomField = writeById(async (ctx, id) => {
  await findOwnCustomField(ctx, id);
  await deleteCustomFieldForCurrentUser(id);
  return noContent();
});

// ─── Notes and wishlist (personal) ─────────────────────────────────────────

async function userLocale(userId: string) {
  return (await findPreferencesForUser(userId)).locale;
}

export const createNote = write(async (ctx) => {
  const body = await jsonBody(ctx, noteFieldsSchema);
  const note = await createNoteForCurrentUser(createNoteSchema.parse(body), await userLocale(ctx.user.id));
  return respondWithResource(ctx.scope, "notes", note.id, 201);
});

export const updateNote = writeById(async (ctx, id) => {
  const row = await findVisibleRow<{ tags: { name: string }[] } & Record<string, unknown>>(
    ctx.scope,
    "notes",
    id,
  );
  const patch = await jsonBody(ctx, notePatchSchema);
  const current = {
    ...pick(row, [
      "title",
      "content",
      "vehicleId",
      "maintenanceTemplateId",
      "maintenanceRecordId",
      "isPinned",
    ] as const),
    tags: row.tags.map((tag) => tag.name),
  };
  const input = updateNoteSchema.parse({ ...current, ...defined(patch), noteId: id });
  await updateNoteForCurrentUser(input, await userLocale(ctx.user.id));
  return respondWithResource(ctx.scope, "notes", id);
});

export const deleteNote = writeById(async (ctx, id) => {
  await findVisibleRow(ctx.scope, "notes", id);
  await deleteNoteForCurrentUser(id);
  return noContent();
});

export const createWishlistItem = write(async (ctx) => {
  const body = await jsonBody(ctx, passthroughSchema);
  const item = await createWishlistItemForCurrentUser(body);
  return respondWithResource(ctx.scope, "wishlistItems", item.id, 201);
});

export const updateWishlistItem = writeById(async (ctx, id) => {
  await findVisibleRow(ctx.scope, "wishlistItems", id);
  const body = await jsonBody(ctx, passthroughSchema);
  await updateWishlistItemForCurrentUser(id, body);
  return respondWithResource(ctx.scope, "wishlistItems", id);
});

export const deleteWishlistItem = writeById(async (ctx, id) => {
  await findVisibleRow(ctx.scope, "wishlistItems", id);
  await deleteWishlistItemForCurrentUser(id);
  return noContent();
});

// ─── Settings ──────────────────────────────────────────────────────────────

export const patchPreferences = write(async (ctx) => {
  const patch = await jsonBody(ctx, preferencesPatchSchema);
  const current = await findPreferencesForUser(ctx.user.id);
  // The repository clamps the due-soon thresholds and leaves appearance alone.
  await upsertPreferencesForUser(ctx.user.id, { ...current, ...defined(patch) });
  return apiJson(preferencesToApi(await findPreferencesForUser(ctx.user.id)));
});

type NotificationSettingsData = Omit<
  NotificationSettingsRecord,
  "lastMaintenanceAlertAt" | "lastOdometerReminderAt"
>;

/** Column defaults from the schema, for a user who never opened the settings page. */
function defaultNotificationSettings(timezone: string): NotificationSettingsData {
  return {
    pushoverEnabled: false,
    pushoverUserKey: null,
    pushoverAppToken: null,
    telegramEnabled: false,
    telegramBotToken: null,
    telegramChatId: null,
    eventMaintenanceOverdue: true,
    eventMaintenanceDueSoon: true,
    eventMaintenanceLogged: false,
    eventExpenseAdded: false,
    eventOdometerReminder: false,
    odometerReminderDays: 7,
    deliveryImmediate: true,
    deliveryScheduled: false,
    scheduledTime: "08:00",
    scheduledDays: "MO,TU,WE,TH,FR,SA,SU",
    minIntervalHours: 6,
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    timezone,
  };
}

/**
 * Credentials stay web-only, so this applies the web form's rules without its
 * network check of Pushover keys: a channel can only be switched on once its
 * credentials are stored.
 */
export const patchNotificationSettings = write(async (ctx) => {
  const patch = await jsonBody(ctx, notificationSettingsPatchSchema);
  const existing = await findNotificationSettings(ctx.user.id);
  const base: NotificationSettingsData = existing
    ? (({ lastMaintenanceAlertAt: _a, lastOdometerReminderAt: _b, ...rest }) => rest)(existing)
    : defaultNotificationSettings((await findPreferencesForUser(ctx.user.id)).timezone);
  const next = { ...base, ...defined(patch) } as NotificationSettingsData;

  if (next.pushoverEnabled && !(next.pushoverUserKey && next.pushoverAppToken)) {
    throw new ApiProblem(422, "channel_not_configured", "Set up Pushover in the web settings first");
  }
  if (next.telegramEnabled && !(next.telegramBotToken && next.telegramChatId)) {
    throw new ApiProblem(422, "channel_not_configured", "Set up Telegram in the web settings first");
  }
  if (!next.deliveryImmediate && !next.deliveryScheduled) {
    throw new ApiProblem(422, "validation_failed", "Select at least one delivery option");
  }
  if (
    !next.eventMaintenanceOverdue &&
    !next.eventMaintenanceDueSoon &&
    !next.eventMaintenanceLogged &&
    !next.eventExpenseAdded &&
    !next.eventOdometerReminder
  ) {
    throw new ApiProblem(422, "validation_failed", "Select at least one notification event");
  }

  await upsertNotificationSettings(ctx.user.id, next);
  return apiJson(notificationSettingsToApi(await findNotificationSettings(ctx.user.id)));
});
