import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { env } from '@/env';
import {
    PROMOTION_LEAD_RETENTION_DAYS,
    PROMOTION_LEAD_PURGE_GRACE_DAYS,
} from '@/app-layer/jobs/promotion-lead-retention';
import { Heading } from '@/components/ui/typography';

/**
 * Privacy notice — a PUBLIC route (no tenant, no auth), because the promotions
 * consent notice links here before a supplier ever sees a farmer's request.
 *
 * ## What this page may and may not say
 *
 * Every factual claim below is one the code actually implements and this
 * session verified:
 *
 *   - sensitive fields are ciphertext at rest        → Epic B manifest
 *   - one farm's data is isolated from another's     → Postgres RLS, FORCEd
 *   - an offer request shares name + message         → the consent notice text
 *   - consent is recorded with a timestamp           → PromotionLead.consentedAt
 *
 * The retention window is rendered from the SAME constants the sweep runs on
 * (`promotion-lead-retention`), never restated as prose. A page saying "24
 * months" while the job keeps them for 36 is the class of defect this work
 * removed; importing the source of truth makes that drift impossible.
 *
 * The data CONTROLLER is the operator of this deployment, not the software, so
 * their identity and contact address come from configuration rather than being
 * invented here. Where it is unset the section is omitted rather than filled
 * with a placeholder that reads as real.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('privacy');
    return { title: t('title'), description: t('intro') };
}

export default async function PrivacyPage() {
    const t = await getTranslations('privacy');
    const contact = env.PRIVACY_CONTACT_EMAIL;

    const sections = [
        { key: 'collect', body: ['collectAccount', 'collectFarm', 'collectRequests'] },
        // `useExchange` added with #1348: the exchange now shares a name with
        // the other farm, exactly as an offer request does. The notice said so
        // for offer requests only, and a document that describes one of two
        // identical disclosures is worse than one that describes neither —
        // a reader would reasonably infer the other does not happen.
        { key: 'use', body: ['useOperate', 'useSuppliers', 'useExchange'] },
        { key: 'protect', body: ['protectEncryption', 'protectIsolation', 'protectConsent'] },
        { key: 'rights', body: ['rightsList'] },
    ] as const;

    const retentionMonths = Math.round(PROMOTION_LEAD_RETENTION_DAYS / 30);

    return (
        <main className="mx-auto max-w-3xl space-y-section px-4 py-12">
            <header className="space-y-default">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-content-muted">{t('intro')}</p>
            </header>

            {sections.map((section) => (
                <section key={section.key} className="space-y-default">
                    <Heading level={2}>{t(`${section.key}Title`)}</Heading>
                    {section.body.map((line) => (
                        <p key={line} className="text-content-muted">
                            {t(line)}
                        </p>
                    ))}
                </section>
            ))}

            <section className="space-y-default">
                <Heading level={2}>{t('keepTitle')}</Heading>
                <p className="text-content-muted">
                    {t('keepRequests', {
                        months: retentionMonths,
                        graceDays: PROMOTION_LEAD_PURGE_GRACE_DAYS,
                    })}
                </p>
            </section>

            <section className="space-y-default">
                <Heading level={2}>{t('controllerTitle')}</Heading>
                <p className="text-content-muted">{t('controllerBody')}</p>
                {/* Rendered only when the operator has configured a real
                    address — an unconfigured deployment shows no contact rather
                    than an invented one. */}
                {contact ? (
                    <p className="text-content-muted">
                        {t('controllerContact')}{' '}
                        <a href={`mailto:${contact}`} className="underline hover:text-content-emphasis">
                            {contact}
                        </a>
                    </p>
                ) : null}
            </section>
        </main>
    );
}
