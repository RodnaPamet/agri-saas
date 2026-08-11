import { redirect } from 'next/navigation';

/**
 * RETIRED — payroll is a CATEGORY on /grain/costs, not its own surface.
 *
 * `/grain/costs` became the register where every kind of cost is entered,
 * so a separate labour-cost page would be a second place to type the same
 * thing. The grain net-worth calculator now reads `CostEntry` for its
 * payroll line, and migration `20260812090000_payroll_expense_to_cost_entry`
 * copied the existing rows across.
 *
 * A REDIRECT rather than a deletion, because this URL is in browser
 * histories, in the sidebar of any still-open tab, and quite possibly in a
 * bookmark — a farmer who followed one of those to a 404 would reasonably
 * conclude their payroll data had been lost. The category filter is
 * pre-applied so they land on the rows they were looking for.
 *
 * The API routes under /api/t/:slug/grain/payroll are deliberately left
 * serving `PayrollExpense`: this migration is additive and the table
 * survives, so a pinned-back image can still read and write it. They are
 * removed in a later, separate change once the new surface has proven
 * itself.
 */
export default async function GrainPayrollPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/grain/costs?category=PAYROLL`);
}
