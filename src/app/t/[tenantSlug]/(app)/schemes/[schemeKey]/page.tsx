import { getTenantCtx } from '@/app-layer/context';
import { getSchemeDetail } from '@/app-layer/usecases/certification-scheme';
import { SchemeDetailClient } from './SchemeDetailClient';

export const dynamic = 'force-dynamic';

/**
 * Certification scheme detail — Server Component.
 *
 * `/schemes` was a dead end. Rows carried `hover:bg-bg-muted`, which promises a
 * click, and had no `onRowClick`; there was no `[schemeKey]` route to click
 * through to. Meanwhile the only working adoption path — `installPack`, which
 * genuinely creates controls and requirement links — sat at
 * `/frameworks/[key]/install`, reachable only through the command palette.
 *
 * This page answers the three questions a farmer has in front of a standard:
 * what does it require, how much of it have I got, and what do I do next.
 */
export default async function SchemeDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; schemeKey: string }>;
}) {
    const { tenantSlug, schemeKey } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    const detail = await getSchemeDetail(ctx, schemeKey);

    return (
        <SchemeDetailClient
            tenantSlug={tenantSlug}
            schemeKey={schemeKey}
            initialDetail={JSON.parse(JSON.stringify(detail))}
            permissions={{ canAdopt: ctx.permissions.canAdmin }}
        />
    );
}
