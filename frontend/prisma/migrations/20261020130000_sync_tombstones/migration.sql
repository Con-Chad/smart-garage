-- Additive: one new table plus AFTER DELETE triggers; no existing table or
-- column is altered.
--
-- Records deleted rows so offline API clients can drop them on their next
-- /api/v1/sync. Triggers (instead of application code) catch every delete
-- path: the web UI, the API, backup imports and FK cascades. Maintenance items
-- and item defaults are not tracked; they travel embedded in their record or
-- schedule, whose updatedAt changes with them. Timestamps are written in the
-- same integer-milliseconds format Prisma uses for SQLite DateTime columns.

-- CreateTable
CREATE TABLE "SyncTombstone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "userId" TEXT,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SyncTombstone_deletedAt_idx" ON "SyncTombstone"("deletedAt");

-- CreateIndex
CREATE INDEX "SyncTombstone_vehicleId_idx" ON "SyncTombstone"("vehicleId");

-- CreateIndex
CREATE INDEX "SyncTombstone_userId_idx" ON "SyncTombstone"("userId");

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_Vehicle_delete" AFTER DELETE ON "Vehicle"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'vehicle', OLD.id, OLD.id, OLD.ownerUserId, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_VehicleShare_delete" AFTER DELETE ON "VehicleShare"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'vehicleAccess', OLD.vehicleId, NULL, OLD.userId, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_VehicleModification_delete" AFTER DELETE ON "VehicleModification"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'modification', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_VehicleCustomField_delete" AFTER DELETE ON "VehicleCustomField"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'customField', OLD.id, NULL, OLD.userId, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_VehicleCustomFieldValue_delete" AFTER DELETE ON "VehicleCustomFieldValue"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'customFieldValue', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_VehicleMaintenanceSchedule_delete" AFTER DELETE ON "VehicleMaintenanceSchedule"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'schedule', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_MaintenanceRecord_delete" AFTER DELETE ON "MaintenanceRecord"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'maintenanceRecord', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_FuelEntry_delete" AFTER DELETE ON "FuelEntry"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'fuelEntry', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_OdometerLog_delete" AFTER DELETE ON "OdometerLog"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'odometerLog', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_Expense_delete" AFTER DELETE ON "Expense"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'expense', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_Document_delete" AFTER DELETE ON "Document"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'document', OLD.id, OLD.vehicleId, OLD.uploadedByUserId, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_VehicleInspection_delete" AFTER DELETE ON "VehicleInspection"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'inspection', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_InsurancePolicy_delete" AFTER DELETE ON "InsurancePolicy"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'insurancePolicy', OLD.id, OLD.vehicleId, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_Note_delete" AFTER DELETE ON "Note"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'note', OLD.id, NULL, OLD.ownerUserId, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;

-- CreateTrigger
CREATE TRIGGER "SyncTombstone_WishlistItem_delete" AFTER DELETE ON "WishlistItem"
BEGIN
    INSERT INTO "SyncTombstone" ("id", "entity", "entityId", "vehicleId", "userId", "deletedAt")
    VALUES (lower(hex(randomblob(16))), 'wishlistItem', OLD.id, NULL, OLD.userId, CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER));
END;
