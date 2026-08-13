import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAssets } from '@/app-layer/usecases/asset';
import { AssetsClient } from './AssetsClient';

export const dynamic = 'force-dynamic';

/**
 * Assets — Server Component wrapper.
 * Fetches asset list server-side (with URL filters applied),
 * delegates interaction to client island.
 */
export default async function AssetsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('assets'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);

    // Build filters from searchParams for server-side data fetch
    const filters: Record<string, string> = {};
    for (const key of ['q', 'type', 'status']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    const assets = await listAssets(ctx, Object.keys(filters).length > 0 ? filters : undefined);

    return (
        <div className="space-y-section animate-fadeIn">
            <AssetsClient
                initialAssets={JSON.parse(JSON.stringify(assets))}
                initialFilters={filters}
                tenantSlug={tenantSlug}
                permissions={{ canWrite: ctx.permissions.canWrite, canAdmin: ctx.permissions.canAdmin }}
                translations={{
                    title: t('title'),
                    listDescription: t('listDescription'),
                    addAsset: t('addAsset'),
                    createAsset: t('createAsset'),
                    name: t('name'),
                    type: t('type'),
                    manufacturer: t('manufacturer'),
                    owner: t('owner'),
                    location: t('location'),
                    noAssets: t('noAssets'),
                    cancel: tc('cancel'),
                    assetsRegistered: t('assetsRegistered', { count: assets.length }),
                }}
            />
        </div>
    );
}
