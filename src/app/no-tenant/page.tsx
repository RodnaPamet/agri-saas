/**
 * /no-tenant — where the Edge sends someone it will not let into a farm.
 *
 * ## It serves TWO refusals, and told both of them the same wrong thing
 *
 * `src/middleware.ts` redirects here for BOTH tenant-gate verdicts:
 * `no_tenant_access` (the token carries no memberships at all) and
 * `cross_tenant` (it carries some, but not this URL's slug). The page's one
 * message said *"ask your admin to invite you, then sign in again"*.
 *
 * For the person who had just created the farm they OWN, that was false
 * (#1738). They need no invitation; "sign in again" happens to work, but for
 * the wrong stated reason — so anyone following the advice literally goes
 * looking for an administrator who does not exist. Hit on production
 * 2026-10-13 creating the platform tenant.
 *
 * ## How it can tell them apart — the open question in #1738
 *
 * > *"Whether the page can tell them apart without a database read is the open
 * > question — the Edge cannot, but `/no-tenant` is a page and pages can."*
 *
 * It can, and that is the only reason this page is the right place for it.
 * `memberships` is a JWT claim minted at sign-in and the Edge has no database,
 * which is why a farm created a moment ago is invisible to the gate. This is a
 * server component, so it reads Postgres and compares the two. A farm the
 * database grants that the token does not carry means the SESSION is stale,
 * not that the person is uninvited.
 *
 * (The wording avoids a colon immediately followed by the word meaning
 * "whichever". `tests/guards/no-explicit-any-ratchet` substring-matches that
 * sequence across `src/**` without blanking comments, so the original phrasing
 * pushed a prose docblock into the TypeScript unsound-type count and failed
 * CI — and a first attempt at this very note failed again by quoting the
 * sequence it was explaining. Filed as its own defect; reworded here rather
 * than re-grading a shared ratchet inside an unrelated PR.)
 *
 * A set difference, not a count — see `slugsTheTokenDoesNotKnow`, which
 * explains the membership-swap case a count would miss.
 *
 * ## The sibling fix does not make the stale arm dead code
 *
 * `FarmWizard` now refreshes the claims itself, so the farm-creation path no
 * longer arrives here. A stale token still does, by routes nothing can
 * refresh: an invitation redeemed in another tab, an auto-provisioned
 * membership, a membership added by an administrator while the person was
 * signed in. This page is the only surface that can explain those, because it
 * is the only one that sees both sources.
 */
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
    accessGrantingTenantSlugs,
    slugsTheTokenDoesNotKnow,
} from '@/lib/auth/membership-presence';

export default async function NoTenantPage() {
    const session = await auth();
    if (!session?.user) {
        redirect('/login');
    }

    const t = await getTranslations('noTenant');
    const email = session.user.email ?? t('yourAccount');

    // The one database read the Edge could not do. Compared against the claim
    // the gate actually refused on, so a person who navigates here directly
    // with a perfectly good token is not told their session is stale.
    const unknownToToken = slugsTheTokenDoesNotKnow(
        await accessGrantingTenantSlugs(session.user.id),
        session.user.memberships ?? [],
    );
    const sessionIsStale = unknownToToken.length > 0;

    return (
        <main className="min-h-screen bg-bg-page flex items-center justify-center p-4">
            <Card elevation="floating" className="max-w-md w-full text-center">
                {/* A padlock is the wrong picture for a stale session: the
                    person is not locked out of anything, their sign-in is
                    simply older than their farm. */}
                <div className="text-4xl mb-4">
                    {sessionIsStale ? '\u{1F504}' : '\u{1F512}'}
                </div>
                <Heading level={1} className="mb-2">
                    {sessionIsStale ? t('staleTitle') : t('title')}
                </Heading>
                <p className="text-content-muted mb-2">
                    {t.rich('signedInAs', {
                        email,
                        b: (chunks) => (
                            <span className="font-medium text-content-default">
                                {chunks}
                            </span>
                        ),
                    })}
                </p>
                <p className="text-content-muted mb-6" data-testid="no-tenant-body">
                    {sessionIsStale ? t('staleBody') : t('body')}
                </p>
                {/* P2.7 — before this, the only control on the page was
                    sign-out, so a user with no membership could not reach
                    their own account settings at all. The account shell is
                    tenant-independent by design, so it is reachable from
                    exactly here. */}
                <Link
                    href="/account/profile"
                    data-testid="no-tenant-account-link"
                    className="mb-3 inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-border-subtle text-sm font-medium text-content-default hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                    {t('accountLink')}
                </Link>

                <form
                    action={async () => {
                        'use server';
                        await signOut({ redirectTo: '/login' });
                    }}
                >
                    <Button type="submit" variant="secondary" className="w-full">
                        {t('signOut')}
                    </Button>
                </form>
            </Card>
        </main>
    );
}
