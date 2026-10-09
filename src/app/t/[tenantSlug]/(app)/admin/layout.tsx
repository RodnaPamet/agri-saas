'use client';

import { useTranslations } from 'next-intl';
import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

/**
 * Admin layout guard — centralized permission check for the entire
 * /t/:tenantSlug/admin/* subtree.
 *
 * Every admin page inherits this guard automatically. Non-admin users
 * see a consistent "Access Denied" experience via ForbiddenPage.
 *
 * Defence-in-depth, corrected 2026-10-09 — the previous version of this list
 * said middleware "redirects non-admin to dashboard", and it does not:
 *
 *   1. Edge middleware (`middleware.ts:279-294`) — for an admin PAGE it
 *      deliberately returns `NextResponse.next()` and defers to this layout,
 *      because 307-redirecting the HTML request crashed the Next 14 dev
 *      server. Only `/api/admin/**` is refused there, with `ADMIN_REQUIRED`.
 *      So the URL STAYS on /admin for a non-admin, which is why an E2E test
 *      asserting `!url.includes('/admin')` was vacuous (#1514).
 *   2. THIS layout — the primary guard for pages, not a catcher of "edge
 *      cases". It is a CLIENT component (`'use client'` above), so it decides
 *      what is DISPLAYED.
 *   3. The data — every admin page reads through `/api/admin/**`, which step 1
 *      refuses for a non-admin. That is what makes a client-side guard
 *      sufficient here: a non-admin receives a page shell whose data never
 *      arrives, not an admin page with rows in it.
 *
 * Step 3 is the load-bearing one and it is easy to lose. If an admin page ever
 * renders tenant data server-side instead of fetching it, this guard stops
 * being enough on its own and that page needs its own server check.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
    const t = useTranslations('admin');
    return (
        <RequirePermission
            resource="admin"
            action="view"
            fallback={
                <ForbiddenPage
                    title={t('forbidden.title')}
                    message={t('forbidden.message')}
                />
            }
        >
            {children}
        </RequirePermission>
    );
}
