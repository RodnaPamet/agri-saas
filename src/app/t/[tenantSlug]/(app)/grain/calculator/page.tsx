import { getTenantCtx } from '@/app-layer/context';
import { getGrainNetWorth } from '@/app-layer/usecases/grain-net-worth';
import { buildCalculatorPayload } from '@/lib/grain/calculator-payload';
import { CalculatorClient } from './CalculatorClient';

export const dynamic = 'force-dynamic';

/**
 * Grain calculator — Server Component (read-only net-worth report).
 *
 * Same shape as `grain/costs/page.tsx`: resolve the tenant context, call the
 * usecase, hand a payload to the client island.
 *
 * Two things this page deliberately does NOT do:
 *
 *   1. **No second module gate.** `grain/layout.tsx` already runs
 *      `requireModule(ctx, 'GRAIN')` for every page in the route group. A
 *      second check here would be redundant work on every request and a
 *      second place to forget to update. NOTE: the API twin
 *      (`/api/t/:slug/grain/calculator`) has no layout above it, so it DOES
 *      gate itself — that asymmetry is real, not an oversight.
 *   2. **No client refetch loop.** The calculator has one shape and one
 *      payload. `force-dynamic` + a server read is the whole data path; the
 *      client island only formats and arranges.
 *
 * ── Where the mapping went ──
 *
 * `toCalculatorRow` used to live here, which was right while this page was the
 * only consumer. It no longer is: the native client needs the same answer over
 * HTTP. Both now call `buildCalculatorPayload`, so the page and the route
 * cannot describe the calculator differently — see that module's header for
 * what the mapping is for and why every field is a primitive.
 */
export default async function GrainCalculatorPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const data = buildCalculatorPayload(await getGrainNetWorth(ctx));

    return <CalculatorClient tenantSlug={tenantSlug} data={data} />;
}
