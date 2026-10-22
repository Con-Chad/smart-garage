-- Web Push (UnifiedPush) subscriptions for the mobile app (fork: con-chad/smart-garage).
-- Purely additive: nullable columns and a defaulted boolean on existing tables,
-- so this is safe to apply to a live install on container start.

-- AlterTable
ALTER TABLE "ApiDevice" ADD COLUMN "pushEndpoint" TEXT;
ALTER TABLE "ApiDevice" ADD COLUMN "pushP256dh" TEXT;
ALTER TABLE "ApiDevice" ADD COLUMN "pushAuth" TEXT;
ALTER TABLE "ApiDevice" ADD COLUMN "pushCreatedAt" DATETIME;
ALTER TABLE "ApiDevice" ADD COLUMN "pushFailedAt" DATETIME;
ALTER TABLE "ApiDevice" ADD COLUMN "pushFailureCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "UserNotificationSettings" ADD COLUMN "mobilePushEnabled" BOOLEAN NOT NULL DEFAULT true;
