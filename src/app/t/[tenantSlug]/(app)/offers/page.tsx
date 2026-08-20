import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listActivePromotions } from '@/app-layer/usecases/promotions';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { formatDate } from '@/lib/format-date';
import { AskForOfferModal } from './AskForOfferModal';

/**
 * Offers (Промоции) — #12. A scrollable feed of company promotions from the
 * GLOBAL Promotion catalogue (shared across tenants). Each card carries an
 * "Ask for offer" lead form. Read-only feed; population is via seed / admin.
 */
export default async function OffersPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const [promotions, t] = await Promise.all([
        listActivePromotions(ctx),
        getTranslations('ag.offers'),
    ]);

    const categoryLabel = (c: string): string => {
        switch (c) {
            case 'culture': return t('catCulture');
            case 'fertilizer': return t('catFertilizer');
            case 'seeds': return t('catSeeds');
            case 'products': return t('catProducts');
            default: return t('catService');
        }
    };

    return (
        <div className="space-y-section p-4">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('title') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-sm text-content-secondary">{t('description')}</p>
            </div>

            {promotions.length === 0 ? (
                <div className="rounded-lg border border-border-subtle bg-bg-default p-6 text-sm text-content-muted">
                    {t('empty')}
                </div>
            ) : (
                <ul className="space-y-default">
                    {promotions.map((p) => (
                        <li
                            key={p.id}
                            className="rounded-lg border border-border-subtle bg-bg-default p-4"
                        >
                            <div className="flex items-start justify-between gap-default">
                                {/*
                                  * Supplier artwork. Fixed box + object-cover so a
                                  * badly-proportioned upload cannot stretch the row
                                  * — every card keeps the same rhythm whatever the
                                  * source image. `alt` is empty on purpose: the
                                  * company and title sit right beside it, so
                                  * announcing the image again is noise to a screen
                                  * reader. Hidden below sm, where the text needs
                                  * the full width more than the feed needs
                                  * decoration.
                                  */}
                                {p.mediaUrl && (
                                    // eslint-disable-next-line @next/next/no-img-element -- streamed from our own auth-gated route, not a static asset next/image can optimise
                                    <img
                                        src={p.mediaUrl}
                                        alt=""
                                        loading="lazy"
                                        className="hidden size-16 flex-shrink-0 rounded-md border border-border-subtle object-cover sm:block"
                                    />
                                )}
                                <div className="min-w-0">
                                    <p className="text-xs font-medium uppercase tracking-wide text-content-subtle">
                                        {p.company}
                                    </p>
                                    <p className="mt-0.5 font-medium text-content-emphasis">{p.title}</p>
                                    {p.body && (
                                        <p className="mt-1 text-sm text-content-muted">{p.body}</p>
                                    )}
                                    {p.validTo && (
                                        <p className="mt-2 text-xs text-content-subtle">
                                            {t('validUntil', { date: formatDate(p.validTo) })}
                                        </p>
                                    )}
                                </div>
                                <span className="flex-shrink-0 rounded-full bg-bg-muted px-2 py-0.5 text-xs text-content-muted">
                                    {categoryLabel(p.category)}
                                </span>
                            </div>
                            <div className="mt-3 flex items-center gap-default">
                                <AskForOfferModal
                                    promotionId={p.id}
                                    company={p.company}
                                    hasRequested={p.hasRequested}
                                />
                                {p.ctaUrl && (
                                    <a
                                        href={p.ctaUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-content-link hover:underline"
                                    >
                                        {t('learnMore')}
                                    </a>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
