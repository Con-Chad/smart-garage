import { apiError, apiJson, requireApiAuth } from "@/lib/api/v1/http";
import { loadApiScope } from "@/lib/api/v1/scope";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const GROUPINGS = ["month", "category", "vehicle"] as const;
type Grouping = (typeof GROUPINGS)[number];

/**
 * `GET /api/v1/expenses/summary?groupBy=month|category|vehicle&vehicleId=&from=&to=`
 *
 * Totals in integer cents per currency (amounts in different currencies are
 * never added together). Months are calendar months in the user's timezone.
 */
export async function GET(request: Request) {
  const auth = await requireApiAuth();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const groupBy = (url.searchParams.get("groupBy") ?? "month") as Grouping;
  if (!GROUPINGS.includes(groupBy)) {
    return apiError(400, "invalid_request", `groupBy must be one of ${GROUPINGS.join(", ")}`);
  }
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  if (from === undefined || to === undefined) {
    return apiError(400, "invalid_request", "from/to must be ISO 8601 dates");
  }
  const vehicleId = url.searchParams.get("vehicleId");

  const scope = await loadApiScope(auth.user.id);
  const [expenses, preferences] = await Promise.all([
    prisma.expense.findMany({
      where: {
        vehicleId: vehicleId ? { in: scope.vehicleIds.filter((id) => id === vehicleId) } : { in: scope.vehicleIds },
        ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: { occurredAt: true, amountCents: true, currency: true, category: true, vehicleId: true },
    }),
    prisma.userPreferences.findUnique({ where: { userId: auth.user.id }, select: { timezone: true } }),
  ]);

  const monthKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: preferences?.timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
  });

  const totals = new Map<string, { key: string; currency: string; totalCents: number; count: number }>();
  for (const expense of expenses) {
    const key =
      groupBy === "month"
        ? monthKey.format(expense.occurredAt).slice(0, 7)
        : groupBy === "category"
          ? expense.category
          : expense.vehicleId;
    const id = `${key}\u0000${expense.currency}`;
    const bucket = totals.get(id) ?? { key, currency: expense.currency, totalCents: 0, count: 0 };
    bucket.totalCents += Number(expense.amountCents);
    bucket.count += 1;
    totals.set(id, bucket);
  }

  const groups = [...totals.values()].sort((a, b) =>
    a.key === b.key ? a.currency.localeCompare(b.currency) : a.key < b.key ? -1 : 1,
  );
  return apiJson({ groupBy, groups });
}

/** null for absent, undefined for malformed. */
function parseDate(raw: string | null): Date | null | undefined {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
