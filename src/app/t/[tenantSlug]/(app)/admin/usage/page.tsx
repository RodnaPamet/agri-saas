import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isPlatformTenant } from '@/lib/auth/platform-support';
import { getUsageInsights } from '@/app-layer/usecases/usage-insights';
import { USAGE_EVENT_RETENTION_DAYS } from '@/app-layer/telemetry/usage-events';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { UsageConsoleClient } from './UsageConsoleClient';

/**
 * Platform-support console — «Използване», the #493 usage view.
 *
 * Owner, 2026-11-01: *"our server, per account"*, with a view per farm and per
 * screen. This is it.
 *
 * `notFound()` rather than a forbidden page, matching `admin/market-prices` and
 * `admin/promotions`: from any other tenant's perspective this console does not
 * exist, and an "access denied" screen would confirm there is a surface worth
 * going to look for — one that reports on every farm.
 *
 * ## It counts; it does not reconstruct
 *
 * Three aggregates and nothing else. No per-user timeline, no event list, no
 * way to ask what a named person did on Tuesday. `distinctUsers` is a COUNT,
 * never a list of ids. The same table could answer that question and this page
 * deliberately cannot — a per-farm usage report is an operational tool, and a
 * per-person activity log is surveillance. That restraint is the product
 * decision, not an incompleteness to be filled in later.
 *
 * ## No API route
 *
 * Nothing else needs this data, and an endpoint would be a second surface to
 * gate. The page is the consumer; the client half below only renders.
 */
export default async function UsageAdminPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ days?: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    if (!isPlatformTenant(tenantSlug) || !ctx.permissions.canAdmin) notFound();

    const { days: rawDays } = await searchParams;
    const t = await getTranslations('admin.usage');
    const insights = await getUsageInsights({ days: Number(rawDays ?? 30) });

    return (
        <div className="space-y-section">
            <PageBreadcrumbs
                items={[
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('breadcrumbAdmin'), href: `/t/${tenantSlug}/admin` },
                    { label: t('breadcrumbUsage') },
                ]}
            />
            <header className="space-y-tight">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-sm text-content-muted">{t('subtitle', { days: insights.days })}</p>
                <p className="text-xs text-content-muted">
                    {t('windowNote', { retention: USAGE_EVENT_RETENTION_DAYS })}
                </p>
            </header>
            <UsageConsoleClient insights={insights} />
        </div>
    );
}
