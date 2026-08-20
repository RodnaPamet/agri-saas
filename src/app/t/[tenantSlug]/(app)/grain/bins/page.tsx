import { getTenantCtx } from '@/app-layer/context';
import { listBins } from '@/app-layer/usecases/grain-bin';
import { BinsClient } from './BinsClient';

export const dynamic = 'force-dynamic';

/**
 * Bins — Server Component.
 *
 * Fetches the grain-bin list (BIN/STORAGE Locations with a computed fill)
 * server-side via the usecase, then delegates interaction to the client
 * island. The GRAIN module gate is handled once in the route-group
 * layout.
 */
export default async function GrainBinsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    const bins = await listBins(ctx);

    // The list itself is NOT filtered server-side — `GET /grain/bins` takes no
    // query params and the client narrows the LIST_TAKE-capped page in memory.
    // What this hands over is the facet STATE, so a shared `?kind=BIN` link
    // paints the same rows on the server as it does on the client's first
    // render. Without it the two disagree and React hydrates over a mismatch.
    // Mirrors journal/page.tsx; the key list is the one facet bins has.
    const filters: Record<string, string> = {};
    for (const key of ['kind']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    return (
        <BinsClient
            initialBins={JSON.parse(JSON.stringify(bins))}
            tenantSlug={tenantSlug}
            permissions={{ canWrite: ctx.permissions.canWrite }}
            initialFilters={filters}
        />
    );
}
