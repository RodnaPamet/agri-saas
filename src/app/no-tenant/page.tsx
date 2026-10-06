/**
 * /no-tenant — Landing page for authenticated users with no active membership.
 *
 * PR 4 will wire Next.js middleware to redirect here when the JWT has no
 * `tenantId` (i.e. the user signed up / signed in but has not yet accepted
 * any invite). For now this page is reachable directly.
 *
 * The page is purely informational — it tells the user what to do next
 * and provides a sign-out button so they can switch accounts.
 */
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default async function NoTenantPage() {
    const session = await auth();
    if (!session?.user) {
        redirect('/login');
    }

    const t = await getTranslations('noTenant');
    const email = session.user.email ?? t('yourAccount');

    return (
        <main className="min-h-screen bg-bg-page flex items-center justify-center p-4">
            <Card elevation="floating" className="max-w-md w-full text-center">
                <div className="text-4xl mb-4">&#x1F512;</div>
                <Heading level={1} className="mb-2">
                    {t('title')}
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
                <p className="text-content-muted mb-6">
                    {t('body')}
                </p>
                {/* P2.7 — before this, the only control on the page was
                    sign-out, so a user with no membership could not reach
                    their own account settings at all. The account shell is
                    tenant-independent by design, so it is reachable from
                    exactly here. */}
                <Link
                    href="/account/profile"
                    data-testid="no-tenant-account-link"
                    className="mb-3 inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-border-subtle text-sm font-medium text-content-default hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
