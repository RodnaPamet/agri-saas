import { getTranslations } from 'next-intl/server';
import { formatDate } from '@/lib/format-date';
import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { resolveTenantContext } from '@/lib/tenant-context';
import prisma from '@/lib/prisma';
import { BillingActions } from './BillingActions';
import { BillingEventLog } from './BillingEventLog';
import { getBillingMode } from '@/lib/billing/entitlements';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { cardVariants } from '@/components/ui/card-variants';
import { cn } from '@/lib/cn';
import { PAST_DUE_GRACE_DAYS, resolvePastDueState } from '@/lib/billing/past-due';

export const dynamic = 'force-dynamic';

/**
 * Admin-only billing overview page.
 * Shows current plan, status, renewal date, trial info, upgrade/manage actions, and event history.
 */
export default async function BillingPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const t = await getTranslations('admin.billing');
    const tPastDue = await getTranslations('billing.pastDue');

    const session = await auth();
    if (!session?.user?.id) notFound();

    let tenantCtx;
    try {
        tenantCtx = await resolveTenantContext({ tenantSlug }, session.user.id);
    } catch {
        notFound();
    }



    // Fetch billing account
    const billingAccount = await prisma.billingAccount.findUnique({
        where: { tenantId: tenantCtx.tenant.id },
    });

    const billingMode = getBillingMode();
    const plan = billingAccount?.plan ?? 'FREE';
    const status = billingAccount?.status ?? 'ACTIVE';
    const periodEnd = billingAccount?.currentPeriodEnd;
    // #1325 — resolved through the single producer so this banner and the
    // gates cannot disagree about whether the grace has run out. A second
    // piece of date arithmetic here is how a page tells somebody they have
    // four days left while the API is already refusing them.
    const pastDue = resolvePastDueState(billingAccount);
    const trialEnd = billingAccount?.trialEndsAt;
    const hasSubscription = !!billingAccount?.stripeSubscriptionId;
    const isTrialing = status === 'TRIALING' && trialEnd;

    // Compute trial days remaining
    let trialDaysRemaining: number | null = null;
    if (isTrialing && trialEnd) {
        // Server component — Date.now() runs once per request server-side,
        // not in a React render cycle. Lint can't distinguish server from client.
        // eslint-disable-next-line react-hooks/purity
        const diffMs = new Date(trialEnd).getTime() - Date.now();
        trialDaysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    // Fetch recent billing events
    const recentEvents = await prisma.billingEvent.findMany({
        where: { tenantId: tenantCtx.tenant.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
            id: true,
            type: true,
            stripeEventId: true,
            createdAt: true,
        },
    });

    return (
        <div className="space-y-page animate-fadeIn">
            {/* Header */}
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('breadcrumbAdmin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('breadcrumbBilling') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('heading')}</Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t.rich('description', {
                        name: tenantCtx.tenant.name,
                        b: (chunks) => <span className="text-content-emphasis font-medium">{chunks}</span>,
                    })}
                </p>
            </div>

            {/* Trial banner */}
            {isTrialing && trialDaysRemaining !== null && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border', trialDaysRemaining <= 3 ? 'border-border-error bg-bg-error' : 'border-border-warning bg-bg-warning')} id="trial-banner">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className={`text-sm font-semibold ${trialDaysRemaining <= 3 ? 'text-content-error' : 'text-content-warning'}`}>
                                {trialDaysRemaining === 0
                                    ? t('trialExpiresToday')
                                    : t('trialDaysLeft', { count: trialDaysRemaining })}
                            </p>
                            <p className="text-xs text-content-muted mt-0.5">
                                {t('trialEndsOn', { date: formatDate(trialEnd) })}
                            </p>
                        </div>
                        {billingMode === 'SAAS' && (
                            <BillingActions plan="PRO" tenantSlug={tenantSlug} />
                        )}
                    </div>
                </div>
            )}

            {/* Current Plan Card */}
            <section className={cardVariants()}>
                <Heading level={2} className="mb-4">{t('currentPlan')}</Heading>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-default">
                    <div>
                        <p className="text-xs text-content-subtle uppercase tracking-wider mb-1">{t('plan')}</p>
                        <StatusBadge variant={plan === 'ENTERPRISE' ? 'warning' :
                            plan === 'PRO' ? 'info' :
                            plan === 'TRIAL' ? 'neutral' :
                            'neutral'} className="text-sm">
                            {plan}
                        </StatusBadge>
                    </div>
                    <div>
                        <p className="text-xs text-content-subtle uppercase tracking-wider mb-1">{t('status')}</p>
                        <StatusBadge variant={status === 'ACTIVE' ? 'info' :
                            status === 'TRIALING' ? 'warning' :
                            status === 'PAST_DUE' ? 'error' :
                            status === 'CANCELED' ? 'error' :
                            'neutral'} className="text-sm">
                            {status.replace('_', ' ')}
                        </StatusBadge>
                    </div>
                    <div>
                        <p className="text-xs text-content-subtle uppercase tracking-wider mb-1">{t('renewal')}</p>
                        <p className="text-sm text-content-emphasis">
                            {periodEnd ? formatDate(periodEnd) : '—'}
                        </p>
                    </div>
                    <div>
                        <p className="text-xs text-content-subtle uppercase tracking-wider mb-1">{t('trialEnds')}</p>
                        <p className="text-sm text-content-emphasis">
                            {trialEnd ? (
                                <>
                                    {formatDate(trialEnd)}
                                    {trialDaysRemaining !== null && (
                                        <span className={`ml-1 text-xs ${trialDaysRemaining <= 3 ? 'text-content-error' : 'text-content-warning'}`}>
                                            {t('daysLeftShort', { count: trialDaysRemaining })}
                                        </span>
                                    )}
                                </>
                            ) : '—'}
                        </p>
                    </div>
                </div>

                {/* Past due warning. Two different messages, because
                    "we could not take payment" and "your access is now
                    reduced" are different facts and a tenant inside the
                    grace has not lost anything yet (#1325). */}
                {status === 'PAST_DUE' && (
                    <InlineNotice
                        variant="error"
                        className="mt-4"
                        title={pastDue.restricted ? tPastDue('restrictedTitle') : tPastDue('graceTitle')}
                    >
                        {pastDue.restricted
                            ? tPastDue('restrictedBody', {
                                  days: PAST_DUE_GRACE_DAYS,
                                  surface: tPastDue('surface.exchange'),
                              })
                            : pastDue.graceEndsAt
                              ? tPastDue('graceBody', { date: formatDate(pastDue.graceEndsAt) })
                              : t('paymentIssueBody')}
                    </InlineNotice>
                )}
            </section>

            {/* Self-hosted banner — billing UI is decorative in this mode.
                Stripe is not configured (STRIPE_SECRET_KEY unset), so plan
                limits resolve to ENTERPRISE for every tenant and the
                Stripe-backed buttons would 403 with "billing_unavailable". */}
            {billingMode === 'SELFHOSTED' && (
                <div
                    className={cn(cardVariants({ density: 'compact' }), 'border border-border-warning bg-bg-warning')}
                    id="billing-self-hosted-banner"
                >
                    <p className="text-sm font-semibold text-content-warning">
                        {t('selfHosted')}
                    </p>
                    <p className="text-xs text-content-muted mt-1">
                        {t('selfHostedBody')}
                    </p>
                </div>
            )}

            {/* Upgrade Options */}
            {billingMode === 'SAAS' && (plan === 'FREE' || plan === 'TRIAL') && (
                <section>
                    <Heading level={2} className="mb-4">{t('upgrade')}</Heading>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                        <div className={cn(cardVariants(), 'border border-[var(--brand-default)]/30 hover:border-[var(--brand-default)]/60 transition')}>
                            <div className="flex items-center justify-between mb-3">
                                <Heading level={3}>{t('pro')}</Heading>
                                <StatusBadge variant="info">{t('recommended')}</StatusBadge>
                            </div>
                            <ul className="text-sm text-content-muted space-y-1 mb-4">
                                <li>{t('proFeature1')}</li>
                                <li>{t('proFeature2')}</li>
                                <li>{t('proFeature3')}</li>
                                <li>{t('proFeature4')}</li>
                            </ul>
                            <BillingActions plan="PRO" tenantSlug={tenantSlug} />
                        </div>
                        <div className={cn(cardVariants(), 'border border-purple-500/30 hover:border-purple-500/60 transition')}>
                            <div className="flex items-center justify-between mb-3">
                                <Heading level={3}>{t('enterprise')}</Heading>
                                <StatusBadge variant="warning">{t('premium')}</StatusBadge>
                            </div>
                            <ul className="text-sm text-content-muted space-y-1 mb-4">
                                <li>{t('entFeature1')}</li>
                                <li>{t('entFeature2')}</li>
                                <li>{t('entFeature3')}</li>
                                <li>{t('entFeature4')}</li>
                            </ul>
                            <BillingActions plan="ENTERPRISE" tenantSlug={tenantSlug} />
                        </div>
                    </div>
                </section>
            )}

            {/* Manage Subscription */}
            {billingMode === 'SAAS' && hasSubscription && (
                <section>
                    <Heading level={2} className="mb-4">{t('manageSubscription')}</Heading>
                    <div className={cardVariants()}>
                        <p className="text-sm text-content-muted mb-4">
                            {t('manageSubscriptionBody')}
                        </p>
                        <BillingActions portal tenantSlug={tenantSlug} />
                    </div>
                </section>
            )}

            {/* Billing Event History */}
            <section>
                <Heading level={2} className="mb-4">{t('recentActivity')}</Heading>
                <BillingEventLog
                    events={recentEvents.map(e => ({
                        id: e.id,
                        type: e.type,
                        stripeEventId: e.stripeEventId,
                        createdAt: e.createdAt.toISOString(),
                    }))}
                />
            </section>
        </div>
    );
}
