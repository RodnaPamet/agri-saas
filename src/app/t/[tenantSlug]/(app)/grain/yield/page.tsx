import { getTenantCtx } from '@/app-layer/context';
import { listYieldRecords } from '@/app-layer/usecases/yield-record';
import { YieldClient } from './YieldClient';

export const dynamic = 'force-dynamic';

/**
 * Yield — Server Component.
 *
 * Fetches the yield-record list server-side via the usecase (each row
 * carries a computed t/ha), then delegates interaction to the client
 * island. The route base is `/grain/yield`; the API is
 * `/grain/yield-records`. The GRAIN module gate is handled once in the
 * route-group layout.
 */
export default async function GrainYieldPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // A shared filtered link must paint filtered on FIRST load. Without
    // this the server rendered the unfiltered register and the client
    // re-fetched — a wasted full-table round trip on rural LTE, and a
    // visible flash of rows the recipient did not ask for. Mirrors the
    // journal page's SSR allow-list, and reads the SAME comma-separated
    // params the API does so the two cannot diverge.
    const csv = (key: string): string[] | undefined => {
        const raw = sp[key];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (!value) return undefined;
        const parts = value.split(',').map((v) => v.trim()).filter(Boolean);
        return parts.length ? parts : undefined;
    };

    const payload = await listYieldRecords(ctx, {
        seasonIds: csv('seasonId'),
        locationIds: csv('locationId'),
        plantingIds: csv('plantingId'),
        commodities: csv('commodity'),
        q: typeof sp.q === 'string' ? sp.q : undefined,
    });

    return (
        <YieldClient
            initialPayload={JSON.parse(JSON.stringify(payload))}
            tenantSlug={tenantSlug}
            permissions={{ canWrite: ctx.permissions.canWrite }}
        />
    );
}
