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
 * Unlinked ON PURPOSE, which is why it is in `pages-are-reachable`'s
 * `DELIBERATELY_UNLINKED` with this reason: nothing inside the product should
 * send anybody the long way round. The path exists to catch a destination
 * another client already resolves — the `/issues/[issueId]` and
 * `/grain/payroll` shape, for the same reason, which is that a URL in the wild
 * must land somewhere real.
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
