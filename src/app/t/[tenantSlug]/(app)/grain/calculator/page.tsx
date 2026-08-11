import { getTenantCtx } from '@/app-layer/context';
import { getGrainNetWorth } from '@/app-layer/usecases/grain-net-worth';
import { CalculatorClient, type CalculatorData } from './CalculatorClient';

export const dynamic = 'force-dynamic';

/**
 * Grain calculator — Server Component (read-only net-worth report).
 *
 * Same shape as `grain/costs/page.tsx`: resolve the tenant context,
 * call the usecase, hand a serialised payload to the client island.
 *
 * Two things this page deliberately does NOT do:
 *
 *   1. **No second module gate.** `grain/layout.tsx` already runs
 *      `requireModule(ctx, 'GRAIN')` for every page in the route group.
 *      A second check here would be redundant work on every request and
 *      a second place to forget to update.
 *   2. **No client refetch loop.** Unlike /grain/costs (which has a
 *      dimension toggle backed by an API route), the calculator has one
 *      shape and one payload. `force-dynamic` + a server read is the
 *      whole data path; the client island only formats and arranges.
 *
 * `JSON.parse(JSON.stringify(...))` mirrors the costs page: the usecase
 * returns plain numbers and strings, and the round-trip is the existing
 * belt-and-braces against a stray Decimal/Date crossing the RSC
 * boundary.
 */
export default async function GrainCalculatorPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const result = await getGrainNetWorth(ctx);
    const data: CalculatorData = JSON.parse(JSON.stringify(result));

    return <CalculatorClient tenantSlug={tenantSlug} data={data} />;
}
