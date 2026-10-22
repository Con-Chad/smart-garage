-- Receipt scanner (fork: con-chad/smart-garage): a receipt photo can link to the
-- fill-up it belongs to, and scans are counted per user for the daily limit.
-- Purely additive. The column is added in place (SQLite allows ADD COLUMN with
-- a nullable REFERENCES), on purpose instead of Prisma's table redefinition,
-- which would DROP "Document" and with it the sync_tombstones triggers.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "fuelEntryId" TEXT REFERENCES "FuelEntry" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Document_fuelEntryId_idx" ON "Document"("fuelEntryId");

-- CreateTable
CREATE TABLE "ReceiptScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "documentId" TEXT,
    "outcome" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ReceiptScan_userId_createdAt_idx" ON "ReceiptScan"("userId", "createdAt");
