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

    // The try wraps ONLY the await, and the JSX is built after it — which is
    // the shape `org/[orgSlug]/layout.tsx` already uses, and the one
    // `react-hooks/error-boundaries` asks for: React does not render the
    // element here, so a `try` around its construction cannot catch anything
    // the component itself throws.
    //
    // Nothing changes behaviourally. `getBin` is awaited inside the old try
    // too, so the NotFoundError mapping worked; everything else was rethrown,
    // which is also what escaping would have done. The point is that the
    // catch's SCOPE now matches what it can actually handle, so a later reader
    // cannot mistake it for a boundary around the component.
    let bin;
    try {
        bin = await getBin(ctx, binId);
    } catch (err) {
        // A bin id that is missing, soft-deleted, another tenant's, or a FIELD
        // must render the 404 page rather than an error boundary.
        if (err instanceof NotFoundError) notFound();
        throw err;
    }

    return (
        <BinDetailClient
            bin={JSON.parse(JSON.stringify(bin))}
            tenantSlug={tenantSlug}
            permissions={{ canWrite: ctx.permissions.canWrite }}
        />
    );
}
