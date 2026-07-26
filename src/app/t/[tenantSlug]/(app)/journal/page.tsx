import { getTenantCtx } from '@/app-layer/context';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';
import { getEnabledModules } from '@/app-layer/usecases/modules';
import { JournalClient, JOURNAL_PAGE_SIZE } from './JournalClient';

export const dynamic = 'force-dynamic';

/**
 * Field Journal — Server Component wrapper.
 *
 * Fetches the journal list server-side (with URL filters applied),
 * delegates interaction to the client island. Mirrors the Assets page.
 */
export default async function JournalPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;

    const ctx = await getTenantCtx({ tenantSlug });

    // The SSR allow-list mirrors the API's JournalQuerySchema exactly, so a
    // shared filtered link paints correctly on first load instead of
    // server-rendering an unfiltered page and re-fetching on the client —
    // which matters on rural LTE.
    const filters: Record<string, string> = {};
    for (const key of ['q', 'type', 'status', 'occurredFrom', 'occurredTo', 'crop', 'locationId']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    // Roadmap-6 P3 — server-render only the FIRST bounded page (not the
    // old flat take:200). The client pages forward over the cursor path.
    const firstPage = await listLogEntriesPaginated(ctx, {
        limit: JOURNAL_PAGE_SIZE,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
    });

    // Resolved here rather than fetched by the modal: the only client-
    // readable module endpoint is admin-gated, and a mechanisator authoring
    // a harvest is not an admin. Drives the "also record as yield" option —
    // a GRAIN concept, so a tenant without the module is never offered it.
    const enabledModules = await getEnabledModules(ctx);

    return (
        <div className="space-y-section animate-fadeIn">
            <JournalClient
                initialEntries={JSON.parse(JSON.stringify(firstPage.items))}
                initialNextCursor={firstPage.pageInfo.nextCursor ?? null}
                initialFilters={filters}
                tenantSlug={tenantSlug}
                permissions={{ canWrite: ctx.permissions.canWrite, canAdmin: ctx.permissions.canAdmin }}
                grainEnabled={enabledModules.includes('GRAIN')}
            />
        </div>
    );
}
