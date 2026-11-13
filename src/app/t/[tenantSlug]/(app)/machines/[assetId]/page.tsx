'use client';
import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';

/**
 * `/machines/[assetId]` → `/assets/[id]`, because the PHONE owns this path and
 * the web does not have the page it names.
 *
 * #2948 stage 5's area alert enqueues `push-send` with
 * `link: /t/{slug}/machines/{assetId}`, and that shape is deliberate and
 * SHIPPED: agrent-ios #577 maps it to `PushLink.machine` → `AppRoute.machineID`
 * in TestFlight 128.1, so changing the server's link would break a build that
 * is already in testers' hands.
 *
 * But one `push-send` reaches BOTH transports through `resolveDelivery`, and on
 * the web there is no machine surface at all — the live map and the day history
 * are iOS screens (#2948 stages 3 and 5), and `find` over
 * `src/app/t/[tenantSlug]/(app)` returns no `machines` segment. So an OWNER who
 * clicked that notification in a browser reached a 404 from the moment stage 5
 * merged.
 *
 * `/assets/[id]` is the nearest real destination and an honest one: it is the
 * same machine's record — its identity, maintenance and linked tasks — reached
 * from an alert about it. It is NOT a map, and a reader should not expect one
 * here until the web gets a fleet surface.
 *
 * ## Not NAVIGABLE, but reachable — and those are different (#3048)
 *
 * Nothing inside the product should link here: a web reader goes to the asset
 * directly, and sending them through a redirect would be the long way round.
 * The path exists to catch a destination another client already resolves —
 * the `/issues/[issueId]` and `/grain/payroll` shape, for the same reason,
 * which is that a URL in the wild must land somewhere real.
 *
 * It is deliberately NOT in `pages-are-reachable`'s `DELIBERATELY_UNLINKED`,
 * and it used to be. That guard asks whether anything offers a way IN, and
 * the push payload above — `` `/t/${slug}/machines/${assetId}` `` — is one: a
 * notification somebody taps is how a person actually arrives here. So the
 * guard finds this page reachable, correctly, and the exemption suppressed
 * nothing from the day it was written. An exemption that excuses nothing
 * keeps its path pre-approved for whatever is created there next (#1285),
 * which is why the claim lives here instead.
 *
 * Delete the page when the web gets a fleet surface, and point the alert at
 * that instead.
 */
export default function MachineRedirect() {
    const router = useRouter();
    const params = useParams();
    const tenantHref = useTenantHref();
    const t = useTranslations('issues');
    const assetId = params?.assetId as string;
    useEffect(() => {
        router.replace(tenantHref(`/assets/${assetId}`));
    }, [router, tenantHref, assetId]);
    /*
     * No `animate-pulse`, unlike the `/issues/[issueId]` redirect this is
     * otherwise copied from. `no-raw-skeleton-pulse` holds raw pulses in
     * `src/app` at 14, and spending one on a frame that is visible for a few
     * milliseconds would take budget from a real loading surface. The line is a
     * courtesy for a slow replace, not a skeleton.
     */
    return <div className="p-12 text-center text-content-subtle">{t('redirecting')}</div>;
}
