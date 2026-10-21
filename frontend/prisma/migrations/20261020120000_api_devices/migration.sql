-- Per-device API tokens for the mobile app (fork: con-chad/smart-garage).
-- Purely additive: a new table only, nothing existing is touched, so this is
-- safe to apply to a live install on container start.
-- CreateTable
CREATE TABLE "ApiDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "ApiDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiDevice_tokenHash_key" ON "ApiDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiDevice_userId_idx" ON "ApiDevice"("userId");

