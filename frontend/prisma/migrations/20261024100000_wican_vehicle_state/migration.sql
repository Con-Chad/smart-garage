-- WiCAN OBD ingest (fork: con-chad/smart-garage): per-vehicle pending trip
-- reading and the distance-since-codes-cleared anchor. Purely additive.

-- CreateTable
CREATE TABLE "WicanVehicleState" (
    "vehicleId" TEXT NOT NULL PRIMARY KEY,
    "pendingOdometerKm" INTEGER,
    "lastSeenAt" DATETIME,
    "anchorLogId" TEXT,
    "anchorOdometerKm" INTEGER,
    "anchorCounterKm" REAL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WicanVehicleState_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WicanVehicleState_lastSeenAt_idx" ON "WicanVehicleState"("lastSeenAt");
