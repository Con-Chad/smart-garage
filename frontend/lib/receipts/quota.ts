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
