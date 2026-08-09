import { getTenantCtx } from '@/app-layer/context';
import { listPractices } from '@/app-layer/usecases/practice';
import { PracticesClient } from './PracticesClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at the most-relevant SSR_PAGE_LIMIT rows so
// the initial HTML payload + DB query stay bounded as tenants
// accumulate practices. The Epic 69 SWR client immediately fetches
// the unbounded list in the background (the existing API GET path),
// and SWR's keepPreviousData swaps it in transparently. UX is
// "first 100 instantly, rest within ~500 ms" — never a blank flash.
// Mirrors the PR #146 Tasks pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Practices — Server Component.
 * Fetches practices list server-side (with URL filters applied),
 * delegates all interaction to client island.
 */
export default async function PracticesPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // Build filters from searchParams for server-side data fetch.
    // Keys here must stay in sync with the Practices filter config
    // (`src/app/t/[tenantSlug]/(app)/practices/filter-defs.ts`) so SSR and
    // client filter state agree on the first paint.
    const filters: Record<string, string> = {};
    for (const key of ['q', 'status', 'applicability', 'ownerUserId', 'category']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    const practices = await listPractices(
        ctx,
        Object.keys(filters).length > 0 ? filters : undefined,
        { take: SSR_PAGE_LIMIT },
    );

    return (
        <PracticesClient
            initialPractices={JSON.parse(JSON.stringify(practices))}
            initialFilters={filters}
            tenantSlug={tenantSlug}
            permissions={ctx.permissions}
            appPermissions={{
                practices: ctx.appPermissions.practices,
            }}
        />
    );
}
