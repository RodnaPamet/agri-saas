import { getTenantCtx } from '@/app-layer/context';
import { isModuleAvailable } from '@/app-layer/usecases/modules';
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
    return <MyListingsClient exchangeEnabled={exchangeEnabled} />;
}
