import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getBin } from '@/app-layer/usecases/grain-bin';
import { NotFoundError } from '@/lib/errors/types';
import { BinDetailClient } from './BinDetailClient';

export const dynamic = 'force-dynamic';

/**
 * Bin detail — Server Component.
 *
 * Before this page existed there was no way to see what was IN a bin: a
 * row-click on the list opened the EDIT form, so a READER got a completely
 * inert table, and `getBin` — a purpose-built read endpoint — had zero
 * callers. This is the page that makes the endpoint worth having.
 *
 * The GRAIN module gate is handled once in the route-group layout.
 */
export default async function GrainBinDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; binId: string }>;
}) {
    const { tenantSlug, binId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    try {
        const bin = await getBin(ctx, binId);
        return (
            <BinDetailClient
                bin={JSON.parse(JSON.stringify(bin))}
                tenantSlug={tenantSlug}
                permissions={{ canWrite: ctx.permissions.canWrite }}
            />
        );
    } catch (err) {
        // A bin id that is missing, soft-deleted, another tenant's, or a FIELD
        // must render the 404 page rather than an error boundary.
        if (err instanceof NotFoundError) notFound();
        throw err;
    }
}
