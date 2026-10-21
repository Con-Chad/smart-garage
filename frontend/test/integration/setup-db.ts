import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, inject } from "vitest";

// Runs before each integration test file is imported: point Prisma at a fresh
// copy of the template so `@/lib/prisma` connects to an isolated database.
const templateDbPath = inject("templateDbPath");
const dbPath = path.join(
  path.dirname(templateDbPath),
  `test-${randomUUID()}.db`,
);
copyFileSync(templateDbPath, dbPath);
process.env.DATABASE_URL = `file:${dbPath}`;

// `lib/prisma.ts` caches its client on globalThis outside production; drop any
// client left over from a previous file in this worker.
const globalForPrisma = globalThis as unknown as {
  prisma?: { $disconnect(): Promise<void> };
  prismaSqliteTuned?: boolean;
};
delete globalForPrisma.prisma;
delete globalForPrisma.prismaSqliteTuned;

afterAll(async () => {
  await globalForPrisma.prisma?.$disconnect();
  delete globalForPrisma.prisma;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
