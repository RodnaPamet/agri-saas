import { getTenantCtx } from '@/app-layer/context';
import { PastDueRestricted } from '@/components/billing/PastDueRestricted';
import { TrendsPageClient } from '@/components/trends/TrendsPageClient';
import { getPastDueState } from '@/lib/billing/entitlements';

/**
 * Trends page — market-price charts.
 *
 * A dashboard-style page visible to every tenant (market data is global, not
 * module-gated — same posture as Offers / Events). The payload is fetched
 * client-side from `/api/t/<slug>/trends/prices`; the page renders an
 * unconfigured/empty state when the backend has no data. The client shell lives
 * in `src/components/trends/` because it mounts the shared tab primitive, which
 * the `single-tab-pattern` guard forbids inside `src/app/**`.
 *
 * It became a SERVER component for #1325. The market data is still global —
 * nothing about that changed — but whether THIS tenant may look at it now
 * depends on its billing standing, and that is a server read. The three
 * underlying routes refuse independently, so this is not a UI-only gate.
 */
export default async function TrendsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const pastDue = await getPastDueState(ctx);
    if (pastDue.restricted) {
        return <PastDueRestricted tenantSlug={tenantSlug} surface="trends" />;
    }

    return <TrendsPageClient />;
}
