import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';

import { FeatureFlagsAdminClient } from './FeatureFlagsAdminClient';

/**
 * «Функции» — the superuser's flag switches (#2706).
 *
 * Owner, 2026-11-01: a web page only the platform superuser sees, with on/off
 * switches for the platform flags. It is how they turn `usage.events` on
 * without a terminal.
 *
 * The `(app)/admin` layout gates on `admin.view`, which every tenant's
 * OWNER/ADMIN holds, so it does NOT deliver the platform restriction. This
 * page adds it, exactly as the promotions console does.
 *
 * `notFound()` rather than a forbidden page, matching `assertPlatformSupport`:
 * from any other tenant's perspective this console genuinely does not exist,
 * and an "Access denied" screen would confirm there is a deployment-wide
 * switchboard worth going looking for.
 */
export default async function FeatureFlagsAdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!isPlatformTenant(tenantSlug) || !ctx.permissions.canAdmin) notFound();

    return <FeatureFlagsAdminClient />;
}
