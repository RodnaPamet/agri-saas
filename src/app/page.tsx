import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';

/**
 * Root: the landing page for a visitor, a redirect for a member (P3.8).
 *
 * ── what changed, and what did not ──
 *
 * An authenticated visitor still goes straight to `/tenants`, which handles
 * 0 / 1 / many memberships. That behaviour is untouched: somebody who already
 * has a farm has no use for a page explaining what the product is.
 *
 * An UNAUTHENTICATED visitor used to be redirected to `/login` by the guard.
 * Now they get this page, which is the first genuinely public page in the
 * product — see the `'/'` entry in `lib/auth/guard.ts`, added EXACT so nothing
 * underneath inherits it.
 *
 * ── the call to action depends on a flag, because the destination does ──
 *
 * `/start` calls `notFound()` when `social.farm-registration` is off, and a
 * flag that does not exist is off. So a landing page that always linked there
 * would, in every environment today, offer a button leading to a 404 — which
 * reads as a broken site rather than an unlaunched feature.
 *
 * With the flag off the page offers sign-in only. That is honest: an existing
 * member can still get in, and nobody is invited through a door that is shut.
 *
 * ── on the copy ──
 *
 * Every claim below is something the codebase actually does — the БАБХ journal
 * and its PDF, cadastral parcels and modelled soil, the lease register, grain
 * contracts, the exchange and price trends. There is no pricing, no user
 * count, no comparison and no superlative, because I cannot substantiate any
 * of those and a landing page is the worst place to guess. The last section
 * says plainly that the product is under active development, which is true and
 * is the kind of thing a farmer deciding whether to put their register in it
 * deserves to read before signing up rather than after.
 */
export default async function Home() {
    const session = await auth();

    if (session?.user?.id) {
        // R-1: the picker handles 0/1/>1 memberships correctly.
        redirect('/tenants');
    }

    const t = await getTranslations('landing');
    // Resolved with no user: there is nobody signed in on this page, so the
    // question is whether the CAPABILITY is launched rather than whether this
    // person is in a cohort.
    const registrationOpen = await isFeatureEnabled('social.farm-registration', null);

    return (
        <main className="mx-auto w-full max-w-2xl px-4 py-12 space-y-default">
            <Heading level={1}>{t('tagline')}</Heading>
            <p className="text-base">{t('lead')}</p>

            <div className="flex flex-col gap-tight sm:flex-row">
                {registrationOpen && (
                    <Link href="/start" className="btn btn-primary btn-sm">
                        {t('ctaStart')}
                    </Link>
                )}
                <Link href="/login" className="btn btn-secondary btn-sm">
                    {t('ctaLogin')}
                </Link>
            </div>

            <Card className="p-6 space-y-tight">
                <Heading level={2}>{t('whatTitle')}</Heading>
                <ul className="list-disc pl-5 space-y-tight text-sm">
                    <li>{t('whatJournal')}</li>
                    <li>{t('whatParcels')}</li>
                    <li>{t('whatLeases')}</li>
                    <li>{t('whatGrain')}</li>
                    <li>{t('whatExchange')}</li>
                </ul>
            </Card>

            <Card className="p-6 space-y-tight">
                <Heading level={2}>{t('honestTitle')}</Heading>
                <p className="text-sm">{t('honestBody')}</p>
            </Card>
        </main>
    );
}
