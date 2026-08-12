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
 * The API routes under /api/t/:slug/grain/payroll, the usecase, the
 * repository and the `PayrollExpense` table itself are GONE as of
 * `20260812180000_drop_payroll_expense`. This redirect is the last thing
 * standing at the old address, and it is the part worth keeping: it costs
 * one file and it is what a bookmark resolves to.
 */
export default async function GrainPayrollPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/grain/costs?category=PAYROLL`);
}
