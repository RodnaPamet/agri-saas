/**
 * /suspended — what a suspended account sees instead of a page (#1657).
 *
 * Owner ruling: a suspended person is told so. The alternative on the table was
 * reusing the tenant layout's `notFound()`, which would have said the farm does
 * not exist — a sentence a farmer cannot act on and cannot tell apart from a
 * mistyped URL.
 *
 * Reached by `redirectIfSuspended`, called from `getTenantServerContext` (every
 * tenant page), the `/tenants` picker and the account layout.
 *
 * ## Three things it deliberately does not do
 *
 * - **It does not name a reason.** Why an account was suspended is a moderation
 *   decision, and Art 17 delivers it as a statement of reasons to the person's
 *   own inbox (`statement-dispatch`). Repeating a summary here would be a
 *   second, un-versioned channel for the same obligation, free to drift from
 *   the one that is legally the record.
 * - **It does not offer an appeal button.** There is no appeal surface yet. A
 *   control that does nothing is worse than its absence on the one page a
 *   person reads when they have just lost access.
 * - **It does not redirect anywhere on its own.** A suspended session is still
 *   a valid session, so sending them to `/login` would sign them straight back
 *   in and bounce them here again. Sign-out is offered, not forced.
 *
 * It is NOT gated on being suspended. Anyone may open it, which keeps it a
 * plain informational page rather than something whose reachability depends on
 * the condition it describes — and an unsuspended person who lands here by a
 * stale link reads a sentence that is simply not about them.
 */
import { getTranslations } from 'next-intl/server';

import { auth, signOut } from '@/auth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';

export default async function SuspendedPage() {
    const session = await auth();
    const t = await getTranslations('suspended');

    return (
        <main className="min-h-screen bg-bg-page flex items-center justify-center p-4">
            <Card elevation="floating" className="max-w-md w-full text-center">
                <div className="text-4xl mb-4">&#x26D4;</div>
                <Heading level={1} className="mb-2">
                    {t('title')}
                </Heading>
                <p className="text-content-muted mb-2">{t('body')}</p>
                <p className="text-content-muted mb-6">{t('whereToLook')}</p>
                {session?.user ? (
                    <form
                        action={async () => {
                            'use server';
                            await signOut({ redirectTo: '/login' });
                        }}
                    >
                        <Button type="submit" variant="secondary">
                            {t('signOut')}
                        </Button>
                    </form>
                ) : null}
            </Card>
        </main>
    );
}
