import { getTenantCtx } from '@/app-layer/context';
import { isModuleAvailable } from '@/app-layer/usecases/modules';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { MyListingsClient } from './MyListingsClient';

/**
 * My listings — the seller's management view (offers I've posted + their
 * inquiries).
 *
 * DELIBERATELY NOT module-gated. This is custody of rows the tenant already
 * posted, and it is the only surface from which they can be withdrawn; a
 * tenant that switches EXCHANGE off has to be able to clean up after itself.
 *
 * It does need to SAY so, though — otherwise the page reads as an ordinary
 * marketplace view while the offers on it are invisible to every buyer. The
 * module state is resolved server-side and handed to the client so the banner
 * is accurate on first paint rather than after a fetch.
 */
export default async function MyListingsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const exchangeEnabled = await isModuleAvailable(ctx, 'EXCHANGE');

    // P6.7 (#1929), resolved HERE for the reason the exchange page gives: there
    // is no client-side flags hook, and adding one would be a second source of
    // truth for a kill switch. Scoped to the VIEWER rather than resolved
    // globally, because a cohort-limited flag is a limited rollout and the
    // control should appear for the people in it.
    //
    // NOT `notFound()` — this page is custody of the tenant's own rows and must
    // stay reachable however the flag is set. Only the attribution switch inside
    // the edit form is P6, so only it is gated.
    const publicProfileEnabled = await isFeatureEnabled('social.public-profile', ctx.userId);

    return (
        <MyListingsClient
            exchangeEnabled={exchangeEnabled}
            publicProfileEnabled={publicProfileEnabled}
        />
    );
}
