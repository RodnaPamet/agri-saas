import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { env } from '@/env';
import { TERMS_VERSION, TERMS_ARE_LEGALLY_REVIEWED } from '@/lib/legal/terms';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

/**
 * Terms of use — a PUBLIC route (no tenant, no auth), because registration
 * links here before an account exists (P3.1).
 *
 * ## The banner is a decision, not decoration
 *
 * The owner's call was: draft these from what the software does, and mark the
 * page clearly as an unreviewed draft. So the banner renders from
 * `TERMS_ARE_LEGALLY_REVIEWED`, and goes away with one edit to that constant
 * when a reviewed version lands — not by somebody remembering to delete
 * markup. A reviewed document still carrying "unreviewed" is as wrong as the
 * reverse, and only one of those is self-correcting.
 *
 * ## What this page may and may not say
 *
 * Same rule as the privacy notice: every factual claim is one the code
 * implements, and anything numeric comes from the source of truth rather than
 * being restated as prose.
 *
 *   - an ЕИК is checked against the register, then reviewed by a person
 *       → P3.7's `/api/public/eik-check` + P3.9's verification console
 *   - a submitted ЕИК is not an accepted one
 *       → `identityVerification: 'pending_review'`, returned unconditionally
 *   - a conflicting claim is DISPUTED, and the incumbent keeps the ЕИК
 *       → the partial unique index on `(eikHash) WHERE status='VERIFIED'`,
 *         and `verifyFarmClaim`'s zero incumbent-touching writes
 *   - uploaded files are scanned
 *       → `ingestUploadedFile` / `scanOrRefuse`
 *   - moderation is a person reading a report, not an automated decision
 *       → there is no automated content-decision code path in this repo
 *   - a daily backup, restore-tested, so a day is the realistic worst case
 *       → the GCE snapshot schedule + `restore-test.yml`
 *
 * The last one is the only place these terms concede something uncomfortable,
 * and it stays: the RPO is up to 24 hours and `docs/slos.md` SLO 6 targets
 * exactly that. A terms page promising better than the infrastructure delivers
 * is the one kind of inaccuracy here that could matter to somebody's deadline.
 *
 * The OPERATOR of the deployment is the counterparty, not the software, so
 * their contact address comes from configuration. Unset renders a line saying
 * so rather than a placeholder that reads as a real address — the privacy
 * page's rule, for the same reason.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('terms');
    return { title: t('title'), description: t('intro') };
}

export default async function TermsPage() {
    const t = await getTranslations('terms');
    const contact = env.DSA_CONTACT_EMAIL;

    // Each section is a heading plus its paragraphs, so adding one is a line
    // here and two keys — not another block of markup to keep in step.
    const sections = [
        { key: 'who', body: ['whoBody'] },
        { key: 'service', body: ['serviceBody', 'serviceNoAdvice'] },
        { key: 'account', body: ['accountBody', 'accountAccuracy'] },
        { key: 'identity', body: ['identityBody', 'identityConflict'] },
        { key: 'yourData', body: ['yourDataBody', 'yourDataSuppliers'] },
        { key: 'rules', body: ['rulesList'] },
        {
            key: 'moderation',
            body: [
                'moderationBody',
                'moderationTools',
                'moderationActions',
                'moderationRedress',
                'moderationReport',
            ],
        },
        { key: 'availability', body: ['availabilityBody', 'availabilityBackups'] },
        { key: 'termination', body: ['terminationBody'] },
        { key: 'changes', body: ['changesBody'] },
        { key: 'liability', body: ['liabilityBody'] },
        { key: 'law', body: ['lawBody'] },
    ] as const;

    return (
        <main className="mx-auto max-w-3xl space-y-section px-4 py-12">
            <header className="space-y-default">
                <Heading level={1}>{t('title')}</Heading>

                {/* Rendered from the constant, so a reviewed version removes
                    this by flipping one boolean. */}
                {!TERMS_ARE_LEGALLY_REVIEWED && (
                    <InlineNotice variant="warning">
                        <span className="font-semibold">{t('draftBannerTitle')}</span>{' '}
                        {t('draftBannerBody')}
                    </InlineNotice>
                )}

                <p className="text-content-muted">{t('intro')}</p>
                <p className="text-sm text-content-muted">
                    {t('versionLabel', { version: TERMS_VERSION })}
                </p>
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
                <Heading level={2}>{t('contactTitle')}</Heading>
                <p className="text-content-muted">{t('contactBody')}</p>
                {contact ? (
                    <p className="text-content-muted">
                        <a
                            href={`mailto:${contact}`}
                            className="underline hover:text-content-emphasis"
                        >
                            {contact}
                        </a>
                    </p>
                ) : (
                    <p className="text-content-muted">{t('contactUnset')}</p>
                )}
                <p className="text-content-muted">
                    <Link href="/privacy" className="underline hover:text-content-emphasis">
                        {t('privacyLink')}
                    </Link>
                    {' · '}
                    <Link href="/dsa-contact" className="underline hover:text-content-emphasis">
                        {t('dsaLink')}
                    </Link>
                </p>
            </section>
        </main>
    );
}
