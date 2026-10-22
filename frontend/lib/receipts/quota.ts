import { prisma } from "@/lib/prisma";

/**
 * Per-user daily limit for receipt scans (D-042). Every attempt is a
 * `ReceiptScan` row, so the count survives restarts and doubles as an audit
 * trail of what was sent to the vision model. Days are UTC so the limit
 * doesn't depend on a user's timezone preference.
 */

export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function secondsUntilNextUtcDay(now: Date = new Date()): number {
  const next = utcDayStart(now).getTime() + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export async function countScansToday(userId: string, now: Date = new Date()): Promise<number> {
  return prisma.receiptScan.count({
    where: { userId, createdAt: { gte: utcDayStart(now) } },
  });
}

export type ScanReservation = {
  /** The `ReceiptScan` row holding the slot; fill in `documentId`/`model` and the outcome later. */
  id: string;
  /** Scans used today including this one. */
  used: number;
};

/**
 * Takes a slot for today *before* anything is billed: the pending row is
 * inserted first and the day's rows are counted afterwards, so N concurrent
 * requests at `used = limit - 1` can never all pass — whoever counts last
 * sees every row that beat it (S-5 in the 2026-10-22 audit). An over-limit
 * reservation is removed again, so a rejected attempt leaves no trace and
 * the user can retry once a slot is free.
 */
export async function reserveScanSlot(input: {
  userId: string;
  vehicleId: string;
  limit: number;
  now?: Date;
}): Promise<ScanReservation | null> {
  const now = input.now ?? new Date();
  const scan = await prisma.receiptScan.create({
    data: { userId: input.userId, vehicleId: input.vehicleId, outcome: "pending", createdAt: now },
    select: { id: true },
  });
  const used = await countScansToday(input.userId, now);
  if (used > input.limit) {
    await releaseScanSlot(scan.id);
    return null;
  }
  return { id: scan.id, used };
}

/** Drops a reservation whose scan never happened (over limit, or the upload failed to save). */
export async function releaseScanSlot(id: string): Promise<void> {
  await prisma.receiptScan.deleteMany({ where: { id } });
}
