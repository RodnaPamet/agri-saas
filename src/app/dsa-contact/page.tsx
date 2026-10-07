import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { env } from '@/env';
import { Heading } from '@/components/ui/typography';

/**
 * The single point of contact required by the EU Digital Services Act — a
 * PUBLIC route, because the people who need it are by definition not signed in
 * (P3.1).
 *
 * ## Why this is its own page and not a line in the terms
 *
 * Articles 11 and 12 ask for a single point of contact that a user, an
 * authority or a court can FIND. A sentence inside a long terms document
 * satisfies the letter and not the purpose: somebody holding an order does not
 * read the terms, they look for the page. It is also linked from the terms, so
 * either route arrives.
 *
 * ## What this page claims about the service, and why each is safe to claim
 *
 *   - not a very large online platform — the designation is a Commission
 *     decision based on monthly active recipients, and this deployment has
 *     tens of users; the claim is that we are not designated, which is a fact
 *     about a published list.
 *   - no automated content-decision system — there is no code path in this
 *     repo that hides, removes or restricts content without a person. The
 *     automated checks that exist (malware scanning on upload, identifier
 *     validation at entry) refuse an ACTION rather than judge content, which
 *     the terms says in those words.
 *   - no recommender system — nothing ranks what a user sees. Lists are sorted
 *     by the column the user chose.
 *   - no advertising — there is no ad surface in the product.
 *
 * Those four are stated because the DSA's heavier obligations attach to them,
 * and saying "we do not have one" is the honest version of a transparency
 * report about systems that do not exist. If any of the four becomes false,
 * this page is wrong and the obligations it waves off are live — which is why
 * each is written as a claim about the code rather than a reassurance.
 *
 * ## The address
 *
 * From configuration, never baked in. This repository is public and the
 * operator's own mailbox is not ours to publish; an unset value renders a line
 * saying it is unset, not a placeholder that reads as real. Same rule as the
 * privacy notice's controller block.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dsa');
    return { title: t('title'), description: t('intro') };
}

export default async function DsaContactPage() {
    const t = await getTranslations('dsa');
    const contact = env.DSA_CONTACT_EMAIL;

    const sections = [
        { key: 'users', body: ['usersBody', 'usersRedress'] },
        { key: 'authorities', body: ['authoritiesBody'] },
        { key: 'languages', body: ['languagesBody'] },
        { key: 'scale', body: ['scaleBody'] },
    ] as const;

    return (
        <main className="mx-auto max-w-3xl space-y-section px-4 py-12">
            <header className="space-y-default">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-content-muted">{t('intro')}</p>
            </header>

            <section className="space-y-default">
                <Heading level={2}>{t('addressTitle')}</Heading>
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
                    <p className="text-content-muted">{t('addressUnset')}</p>
                )}
            </section>

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
                <p className="text-content-muted">
                    <Link href="/terms" className="underline hover:text-content-emphasis">
                        {t('termsLink')}
                    </Link>
                    {' · '}
                    <Link href="/privacy" className="underline hover:text-content-emphasis">
                        {t('privacyLink')}
                    </Link>
                </p>
            </section>
        </main>
    );
}
