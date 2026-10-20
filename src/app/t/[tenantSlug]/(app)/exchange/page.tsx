import { getTenantCtx } from '@/app-layer/context';
import { requireModule } from '@/lib/security/require-module';
import { getPastDueState } from '@/lib/billing/entitlements';
import { PastDueRestricted } from '@/components/billing/PastDueRestricted';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { ExchangeClient } from './ExchangeClient';

/**
 * Exchange main page — a map of Bulgaria showing every tenant's P2P offers,
 * with a synced, filterable offer list. Data is fetched client-side from
 * `/api/t/<slug>/exchange/listings`.
 *
 * The module gate lives HERE rather than in the group `layout.tsx`, because
 * browsing is PARTICIPATION in the marketplace while `/exchange/my-listings`
 * is CUSTODY of your own rows and must stay reachable after an opt-out. See
 * that layout for the full reasoning.
 */
export default async function ExchangePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    await requireModule(ctx, 'EXCHANGE');

    // #1325 — a payment outstanding past the 14-day grace closes BROWSING,
    // and this surface is the right place for that because the module gate
    // above already draws the same line: browsing is PARTICIPATION in the
    // marketplace, while `/exchange/my-listings` is CUSTODY of your own rows
    // and stays reachable. Rendered rather than redirected — see the
    // component for why `requireModule`'s redirect is wrong here.
    const pastDue = await getPastDueState(ctx);
    if (pastDue.restricted) {
        return <PastDueRestricted tenantSlug={tenantSlug} surface="exchange" />;
    }

    // P6.7 (#1929). Resolved HERE because there is no client-side flags hook —
    // the same shape `admin/public-profile/page.tsx` and the exchange thread
    // page use.
    //
    // NOT `notFound()`, unlike those pages: the exchange is not a social
    // surface and browsing offers must keep working with the flag off. Only
    // the ATTRIBUTION control is P6, so only it is gated, and the page it
    // sits on is unaffected.
    //
    // Scoped to the VIEWER (`ctx.userId`) rather than resolved globally,
    // because a cohort-limited flag is a limited rollout and the switch
    // should appear for the people in it rather than for everyone the moment
    // the flag turns on at all.
    const publicProfileEnabled = await isFeatureEnabled('social.public-profile', ctx.userId);

    return <ExchangeClient publicProfileEnabled={publicProfileEnabled} />;
}
