import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';

import { AccountActionsClient } from './AccountActionsClient';
import { ModerationQueueClient } from './ModerationQueueClient';

/**
 * «Сигнали» — the Art 16 triage queue and the Art 17 decision (#2735).
 *
 * ## Why this page is the point of the issue, not an accessory to it
 *
 * P5.4a shipped the queue and the decision behind `verifyPlatformApiKey`, so
 * the only attribution available was a KEY GENERATION — one
 * `PLATFORM_ADMIN_API_KEY` is shared, and the repo says the consequence
 * plainly: *"a regulator asking 'who decided this' gets 'somebody holding the
 * key'"*. The fix is not a better string in the column; it is a caller who IS
 * a person. That means a session, and a session means a page.
 *
 * So shipping the API sibling without this page would have recreated the
 * defect it exists to fix — #2844's shape, a complete reachable mechanism that
 * nothing offers anybody, which is exactly what left one farm claim PENDING
 * for 28 days.
 *
 * ## The admin layout's gate is NOT the platform gate
 *
 * The `(app)/admin` layout gates on `admin.view`, which every tenant's
 * OWNER/ADMIN holds. These models are TENANTLESS — `ContentReport`,
 * `ModerationAction` and `StatementOfReasons` deny `app_user` outright — so
 * without the platform restriction an ADMIN of any one farm could triage every
 * other farm's notices. This page adds it, as the flag, promotions and
 * farm-claim consoles do.
 *
 * `notFound()` rather than a forbidden page, matching `assertPlatformSupport`:
 * from another tenant's perspective this console genuinely does not exist, and
 * an "Access denied" screen would confirm there is a place where other
 * people's content gets judged.
 */
export default async function ModerationQueuePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!isPlatformTenant(tenantSlug) || !ctx.permissions.canAdmin) notFound();

    return (
        <>
            <ModerationQueueClient tenantSlug={tenantSlug} />
            {/*
              * Below the queue, not beside it: deciding a notice and acting on
              * something already decided are different jobs, and P5.1 kept
              * `subjectKind: 'ACCOUNT'` separate from the content kinds so that
              * "somebody reported this profile" and "we suspended this account"
              * are not one query (#2735, PR 3).
              */}
            <AccountActionsClient />
        </>
    );
}
