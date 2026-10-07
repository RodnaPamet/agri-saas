import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { sanitizeRedirectPath } from '@/lib/auth/guard';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';
import { AcceptTermsForm } from './AcceptTermsForm';

/**
 * The consent interstitial (P3.1 / #1376).
 *
 * A signed-in session with no recorded terms acceptance is held here by the
 * Edge before it reaches any tenant or person surface. It exists because the
 * two ways into this product do not agree: `register/start` captures consent
 * inline, and a first-time Google sign-in creates its `User` row inside
 * NextAuth's `PrismaAdapter`, recording none.
 *
 * ── it is a hold, not a wall ──
 *
 * The page offers two things: accept, or sign out. It deliberately does not
 * offer "continue without accepting", because that is the state the gate
 * exists to end — and it does not trap anybody either: `/api/auth/` stays
 * reachable so sign-out works, and `/terms` and `/privacy` stay readable,
 * since asking somebody to accept a document they cannot open is not consent.
 *
 * ── why a page and not a modal ──
 *
 * A modal lives inside the app shell, which means rendering the thing being
 * gated behind it. A URL-addressable page is also what makes the Edge
 * redirect possible at all, and it is the same shape as the MFA challenge
 * (`/t/:slug/auth/mfa`) this gate is modelled on — except tenant-LESS, because
 * accepting terms is an identity-level act and a user may hold several farms.
 *
 * ── `next` ──
 *
 * Carried through so accepting returns somebody to what they were trying to
 * reach, and passed through `sanitizeRedirectPath` because it arrives from a
 * query string. The middleware sets it; a crafted one must not become an open
 * redirect.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('acceptTerms');
    return { title: t('title') };
}

interface PageProps {
    searchParams: Promise<{ next?: string }>;
}

export default async function AcceptTermsPage({ searchParams }: PageProps) {
    const session = await auth();

    // Not signed in: there is nobody to record an acceptance for. The gate
    // only ever sends an authenticated session here, so this is the
    // hand-typed-URL case.
    if (!session?.user?.id) {
        redirect('/login');
    }

    // Already accepted — do not show a consent page to somebody who has
    // consented. Reachable by a back button after accepting, and by anyone
    // typing the URL.
    if (session.user.termsPending !== true) {
        redirect('/tenants');
    }

    const { next } = await searchParams;
    const t = await getTranslations('acceptTerms');

    return (
        <main className="mx-auto w-full max-w-xl px-4 py-12 space-y-default">
            <Heading level={1}>{t('title')}</Heading>
            <p className="text-content-muted">{t('why')}</p>

            <Card className="p-6 space-y-default">
                <AcceptTermsForm
                    termsVersion={TERMS_VERSION}
                    next={sanitizeRedirectPath(next)}
                />
            </Card>
        </main>
    );
}
