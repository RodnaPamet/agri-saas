import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';
import { PriceOverridesClient } from './PriceOverridesClient';

/**
 * Platform-support console — «Цени», the superuser daily price override (#1587).
 *
 * The `(app)/admin` layout gates on `admin.view`, which every tenant's
 * OWNER/ADMIN holds, so it does NOT deliver the platform restriction. This page
 * adds it, the same way `admin/promotions` does.
 *
 * `notFound()` rather than a forbidden page, matching `assertPlatformSupport`:
 * from any other tenant's perspective this console genuinely does not exist,
 * and an "Access denied" screen would confirm there is a surface worth going
 * looking for — one that sets the price for every farm.
 *
 * This is the highest-stakes page in the console. A number typed here does not
 * merely add a line to a chart: `source: 'platform'` SUPPRESSES the feed for
 * the reference price, so it moves `getGrainNetWorth`, contracts and the
 * headline figure on every farm until a superuser clears it.
 */
export default async function MarketPricesAdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!isPlatformTenant(tenantSlug) || !ctx.permissions.canAdmin) notFound();

    return <PriceOverridesClient />;
}
