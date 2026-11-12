import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';

import { FarmClaimsReviewClient } from './FarmClaimsReviewClient';

/**
 * «Потвърждаване на стопанства» — the farm-identity review queue (#2963).
 *
 * P3.9 shipped the whole mechanism — usecase, keyed queue route, keyed verify
 * route, all Edge-reachable — and no way in for a person. Measured 2026-11-10:
 * **one claim, PENDING since 2026-10-13**, because reviewing it meant holding
 * `PLATFORM_ADMIN_API_KEY` and composing a request by hand. That is #2844's
 * shape, not the Edge-severance shape: a complete, reachable mechanism nothing
 * offers anybody.
 *
 * `FarmIdentityClaim.status = VERIFIED` is what «verified farm» means
 * product-wide, so the empty queue is not cosmetic: P9.3d's auto-hide needs
 * three DISTINCT verified farms to have reported a post and is arithmetically
 * unreachable while the count is zero.
 *
 * The `(app)/admin` layout gates on `admin.view`, which every tenant's
 * OWNER/ADMIN holds, so it does NOT deliver the platform restriction. This
 * page adds it, exactly as the flag console and the promotions console do.
 *
 * `notFound()` rather than a forbidden page, matching `assertPlatformSupport`:
 * from another tenant's perspective this console genuinely does not exist, and
 * an "Access denied" screen would confirm there is a place where farm
 * identities get decided.
 */
export default async function FarmClaimsReviewPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!isPlatformTenant(tenantSlug) || !ctx.permissions.canAdmin) notFound();

    return <FarmClaimsReviewClient tenantSlug={tenantSlug} />;
}
