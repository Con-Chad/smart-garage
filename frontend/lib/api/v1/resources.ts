import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseVehicleMetadata } from "@/lib/domain/vehicle-metadata";
import { serializeMaintenanceItem } from "@/lib/repositories/maintenance-items";
import type { ApiScope } from "@/lib/api/v1/scope";

/**
 * The read side of `/api/v1`: one definition per synced entity, shared by the
 * list/detail endpoints and `/sync`, so visibility rules and wire shapes can't
 * drift apart. Values are in stored units (km, liters, integer cents) with ISO
 * dates; enums are sent as their Prisma names.
 */

export type ApiRow = { id: string; updatedAt: Date };

type FindArgs = { where: object; orderBy: object[]; take: number };

/** Extra context for "changed since" checks during a sync. */
export type ChangeContext = {
  scope: ApiScope;
  /** Vehicles shared with the user after the sync's lower bound. */
  newlySharedVehicleIds: string[];
  /** Owners of those vehicles. */
  newSharerIds: string[];
};

export type ResourceDef<R extends ApiRow = ApiRow> = {
  /** Base visibility for the user. Never includes rows they can't see. */
  visible: (scope: ApiScope) => object;
  /**
   * Conditions besides the row's own `updatedAt` that mean "changed": an
   * embedded child changed, or the row became visible through a new share.
   */
  alsoChangedSince?: (since: Date, ctx: ChangeContext) => object[];
  find: (args: FindArgs) => Promise<R[]>;
  toApi: (row: R, scope: ApiScope) => unknown;
  /** Non-null column that list endpoints sort by, with `id` as tie-breaker. */
  listOrder: { field: string; direction: "asc" | "desc" };
  /** Query parameters accepted as equality filters on list endpoints. */
  filters?: readonly string[];
};

function define<R extends ApiRow>(def: ResourceDef<R>): ResourceDef {
  return def as unknown as ResourceDef;
}

const inVehicles = (scope: ApiScope) => ({ vehicleId: { in: scope.vehicleIds } });

/** Rows of vehicles that were shared with the user after the lower bound. */
function newlyShared(ctx: ChangeContext, column = "vehicleId"): object[] {
  return ctx.newlySharedVehicleIds.length > 0
    ? [{ [column]: { in: ctx.newlySharedVehicleIds } }]
    : [];
}

const specOmit = { vehicleId: true } as const;

type SpecRow = Omit<Prisma.VehicleCurrentSpecGetPayload<object>, "vehicleId" | "updatedAt"> & {
  updatedAt?: Date;
};

function specToApi(spec: SpecRow | null) {
  if (!spec) return null;
  return {
    engineCode: spec.engineCode,
    engineDescription: spec.engineDescription,
    powerKw: spec.powerKw,
    powerPs: spec.powerPs,
    torqueNm: spec.torqueNm,
    fuelType: spec.fuelType,
    displacementCc: spec.displacementCc,
    cylinders: spec.cylinders,
    doors: spec.doors,
    seats: spec.seats,
    bodyType: spec.bodyType,
    driveType: spec.driveType,
    transmissionTypes: spec.transmissionTypes,
  };
}

const vehicleInclude = {
  owner: { select: { id: true, username: true, displayName: true } },
  factorySpecs: { omit: { ...specOmit, rawCatalog: true } },
  currentSpecs: { omit: specOmit },
  documents: {
    where: { purpose: "VEHICLE_IMAGE", deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true },
  },
} satisfies Prisma.VehicleInclude;

type VehicleRow = Prisma.VehicleGetPayload<{ include: typeof vehicleInclude }>;

const vehicles = define<VehicleRow>({
  visible: (scope) => ({ id: { in: scope.vehicleIds } }),
  alsoChangedSince: (since, ctx) => [
    { currentSpecs: { updatedAt: { gt: since } } },
    // Role changes and new photos don't touch the vehicle row itself.
    { shares: { some: { userId: ctx.scope.userId, updatedAt: { gt: since } } } },
    { documents: { some: { purpose: "VEHICLE_IMAGE", createdAt: { gt: since } } } },
    ...newlyShared(ctx, "id"),
  ],
  find: (args) =>
    prisma.vehicle.findMany({
      where: args.where as Prisma.VehicleWhereInput,
      orderBy: args.orderBy as Prisma.VehicleOrderByWithRelationInput[],
      take: args.take,
      include: vehicleInclude,
    }),
  toApi: (row, scope) => {
    const grant = scope.grants.get(row.id);
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      owner: row.owner,
      access: { role: grant?.role ?? "OWNER", canEdit: grant?.canEdit ?? false },
      make: row.make,
      model: row.model,
      year: row.year,
      productionYear: row.productionYear,
      vin: row.vin,
      hsn: row.hsn,
      tsn: row.tsn,
      licensePlate: row.licensePlate,
      color: parseVehicleMetadata(row.metadata).color ?? null,
      currentOdometerKm: row.currentOdometerKm,
      purchaseDate: row.purchaseDate,
      purchasePriceCents: row.purchasePriceCents,
      purchaseCurrency: row.purchaseCurrency,
      notes: row.notes,
      manufacturerId: row.manufacturerId,
      catalogModelYearId: row.catalogModelYearId,
      imageDocumentId: row.documents[0]?.id ?? null,
      factorySpecs: specToApi(row.factorySpecs),
      currentSpecs: specToApi(row.currentSpecs),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
  listOrder: { field: "updatedAt", direction: "desc" },
});

const modifications = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.vehicleModification.findMany({
      where: args.where as Prisma.VehicleModificationWhereInput,
      orderBy: args.orderBy as Prisma.VehicleModificationOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "createdAt", direction: "desc" },
  filters: ["vehicleId"],
});

const customFields = define({
  // A shared vehicle's values belong to the owner's field definitions.
  visible: (scope) => ({ userId: { in: [scope.userId, ...scope.sharerIds] } }),
  alsoChangedSince: (_since, ctx) =>
    ctx.newSharerIds.length > 0 ? [{ userId: { in: ctx.newSharerIds } }] : [],
  find: (args) =>
    prisma.vehicleCustomField.findMany({
      where: args.where as Prisma.VehicleCustomFieldWhereInput,
      orderBy: args.orderBy as Prisma.VehicleCustomFieldOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "createdAt", direction: "asc" },
});

const customFieldValues = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.vehicleCustomFieldValue.findMany({
      where: args.where as Prisma.VehicleCustomFieldValueWhereInput,
      orderBy: args.orderBy as Prisma.VehicleCustomFieldValueOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "updatedAt", direction: "desc" },
  filters: ["vehicleId", "fieldId"],
});

const scheduleInclude = {
  itemDefaults: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.VehicleMaintenanceScheduleInclude;

type ScheduleRow = Prisma.VehicleMaintenanceScheduleGetPayload<{
  include: typeof scheduleInclude;
}>;

const schedules = define<ScheduleRow>({
  // Deactivated schedules are "deleted" in the web UI; /sync reports them as deletions.
  visible: (scope) => ({ ...inVehicles(scope), isActive: true }),
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.vehicleMaintenanceSchedule.findMany({
      where: args.where as Prisma.VehicleMaintenanceScheduleWhereInput,
      orderBy: args.orderBy as Prisma.VehicleMaintenanceScheduleOrderByWithRelationInput[],
      take: args.take,
      include: scheduleInclude,
    }),
  toApi: ({ itemDefaults, ...row }) => ({
    ...row,
    itemDefaults: itemDefaults.map(serializeMaintenanceItem),
  }),
  listOrder: { field: "createdAt", direction: "asc" },
  filters: ["vehicleId"],
});

const recordInclude = {
  items: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.MaintenanceRecordInclude;

type RecordRow = Prisma.MaintenanceRecordGetPayload<{ include: typeof recordInclude }>;

const maintenanceRecords = define<RecordRow>({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.maintenanceRecord.findMany({
      where: args.where as Prisma.MaintenanceRecordWhereInput,
      orderBy: args.orderBy as Prisma.MaintenanceRecordOrderByWithRelationInput[],
      take: args.take,
      include: recordInclude,
    }),
  toApi: ({ items, ...row }) => ({ ...row, items: items.map(serializeMaintenanceItem) }),
  listOrder: { field: "performedAt", direction: "desc" },
  filters: ["vehicleId", "scheduleId"],
});

const fuelEntries = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.fuelEntry.findMany({
      where: args.where as Prisma.FuelEntryWhereInput,
      orderBy: args.orderBy as Prisma.FuelEntryOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "filledAt", direction: "desc" },
  filters: ["vehicleId"],
});

const odometerLogs = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.odometerLog.findMany({
      where: args.where as Prisma.OdometerLogWhereInput,
      orderBy: args.orderBy as Prisma.OdometerLogOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "recordedAt", direction: "desc" },
  filters: ["vehicleId"],
});

const expenses = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.expense.findMany({
      where: args.where as Prisma.ExpenseWhereInput,
      orderBy: args.orderBy as Prisma.ExpenseOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "occurredAt", direction: "desc" },
  filters: ["vehicleId", "maintenanceRecordId"],
});

const documents = define({
  // Same rule as downloads: files on visible vehicles plus the user's own uploads.
  visible: (scope) => ({
    deletedAt: null,
    OR: [{ vehicleId: { in: scope.vehicleIds } }, { uploadedByUserId: scope.userId }],
  }),
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.document.findMany({
      where: args.where as Prisma.DocumentWhereInput,
      orderBy: args.orderBy as Prisma.DocumentOrderByWithRelationInput[],
      take: args.take,
      // Storage details stay server-side; content is fetched via /documents/{id}/content.
      omit: { storageKey: true, storageBackend: true, deletedAt: true },
    }),
  toApi: (row) => row,
  listOrder: { field: "createdAt", direction: "desc" },
  filters: ["vehicleId", "maintenanceRecordId", "expenseId"],
});

const inspections = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.vehicleInspection.findMany({
      where: args.where as Prisma.VehicleInspectionWhereInput,
      orderBy: args.orderBy as Prisma.VehicleInspectionOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "nextDueAt", direction: "asc" },
  filters: ["vehicleId"],
});

const insurancePolicies = define({
  visible: inVehicles,
  alsoChangedSince: (_since, ctx) => newlyShared(ctx),
  find: (args) =>
    prisma.insurancePolicy.findMany({
      where: args.where as Prisma.InsurancePolicyWhereInput,
      orderBy: args.orderBy as Prisma.InsurancePolicyOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "endDate", direction: "desc" },
  filters: ["vehicleId"],
});

const noteInclude = {
  tags: { select: { name: true }, orderBy: { name: "asc" } },
} satisfies Prisma.NoteInclude;

type NoteRow = Prisma.NoteGetPayload<{ include: typeof noteInclude }>;

const notes = define<NoteRow>({
  // Notes are private to their author, even when linked to a shared vehicle.
  visible: (scope) => ({ ownerUserId: scope.userId }),
  find: (args) =>
    prisma.note.findMany({
      where: args.where as Prisma.NoteWhereInput,
      orderBy: args.orderBy as Prisma.NoteOrderByWithRelationInput[],
      take: args.take,
      include: noteInclude,
    }),
  toApi: ({ tags, ...row }) => ({ ...row, tags: tags.map((tag) => tag.name) }),
  listOrder: { field: "updatedAt", direction: "desc" },
  filters: ["vehicleId", "maintenanceRecordId"],
});

const wishlistItems = define({
  visible: (scope) => ({ userId: scope.userId }),
  find: (args) =>
    prisma.wishlistItem.findMany({
      where: args.where as Prisma.WishlistItemWhereInput,
      orderBy: args.orderBy as Prisma.WishlistItemOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "createdAt", direction: "desc" },
  filters: ["vehicleId"],
});

const maintenanceTemplates = define({
  visible: () => ({ isSystem: true }),
  find: (args) =>
    prisma.maintenanceTemplate.findMany({
      where: args.where as Prisma.MaintenanceTemplateWhereInput,
      orderBy: args.orderBy as Prisma.MaintenanceTemplateOrderByWithRelationInput[],
      take: args.take,
    }),
  toApi: (row) => row,
  listOrder: { field: "sortOrder", direction: "asc" },
});

/**
 * Registry, in sync order: parents before children, so a client that
 * applies pages in order never sees a row before the row it points to.
 */
export const RESOURCES = {
  maintenanceTemplates,
  customFields,
  vehicles,
  modifications,
  customFieldValues,
  schedules,
  maintenanceRecords,
  fuelEntries,
  odometerLogs,
  expenses,
  documents,
  inspections,
  insurancePolicies,
  notes,
  wishlistItems,
} satisfies Record<string, ResourceDef>;

export type ResourceKey = keyof typeof RESOURCES;

export const RESOURCE_KEYS = Object.keys(RESOURCES) as ResourceKey[];
