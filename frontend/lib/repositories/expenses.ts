import type { ExpenseCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { vehicleAccessWhere, vehicleEditWhere } from "@/lib/vehicles/access";

export type SerializedExpense = {
  id: string;
  vehicleId: string;
  vehicleName: string | null;
  category: ExpenseCategory;
  occurredAt: string;
  amountCents: number;
  currency: string;
  odometerKm: number | null;
  maintenanceRecordId: string | null;
  description: string | null;
  createdAt: string;
};

const expenseInclude = {
  vehicle: {
    select: {
      id: true,
      make: true,
      model: true,
      licensePlate: true,
      ownerUserId: true,
    },
  },
} as const;

type ExpenseRow = Awaited<
  ReturnType<typeof prisma.expense.findMany<{ include: typeof expenseInclude }>>
>[number];

function vehicleLabel(vehicle: ExpenseRow["vehicle"]): string | null {
  const name = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
  return name || vehicle.licensePlate || null;
}

export function serializeExpense(expense: ExpenseRow): SerializedExpense {
  return {
    id: expense.id,
    vehicleId: expense.vehicleId,
    vehicleName: vehicleLabel(expense.vehicle),
    category: expense.category,
    occurredAt: expense.occurredAt.toISOString(),
    amountCents: Number(expense.amountCents),
    currency: expense.currency,
    odometerKm: expense.odometerKm,
    maintenanceRecordId: expense.maintenanceRecordId,
    description: expense.description,
    createdAt: expense.createdAt.toISOString(),
  };
}

/** Expenses on vehicles the user owns or that are shared with them. */
export async function listExpensesForOwner(
  userId: string,
  vehicleId?: string,
) {
  return prisma.expense.findMany({
    where: {
      vehicle: vehicleAccessWhere(userId),
      ...(vehicleId ? { vehicleId } : {}),
    },
    include: expenseInclude,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function findExpenseForOwner(expenseId: string, userId: string) {
  return prisma.expense.findFirst({
    where: {
      id: expenseId,
      vehicle: vehicleAccessWhere(userId),
    },
    include: expenseInclude,
  });
}

export async function createExpenseRecord(input: {
  vehicleId: string;
  category: ExpenseCategory;
  occurredAt: Date;
  amountCents: bigint;
  currency: string;
  odometerKm?: number | null;
  maintenanceRecordId?: string | null;
  description?: string | null;
  createdByUserId: string;
}) {
  return prisma.expense.create({
    data: {
      vehicleId: input.vehicleId,
      category: input.category,
      occurredAt: input.occurredAt,
      amountCents: input.amountCents,
      currency: input.currency,
      odometerKm: input.odometerKm ?? null,
      maintenanceRecordId: input.maintenanceRecordId ?? null,
      description: input.description?.trim() || null,
      createdByUserId: input.createdByUserId,
    },
    include: expenseInclude,
  });
}

/** Deletes an expense, scoped to vehicles the user may edit. */
export async function deleteExpenseRecord(expenseId: string, userId: string) {
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, vehicle: vehicleEditWhere(userId) },
    select: { id: true },
  });
  if (!expense) return false;
  await prisma.expense.delete({ where: { id: expenseId } });
  return true;
}

export async function countExpensesForVehicle(vehicleId: string) {
  return prisma.expense.count({ where: { vehicleId } });
}
