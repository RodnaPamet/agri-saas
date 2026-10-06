import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { Heading } from '@/components/ui/typography';
import { ChevronLeft } from '@/components/ui/icons/nucleo/chevron-left';
import { AccountNav } from './AccountNav';

/**
 * The personal-settings shell (P2.7).
 *
 * ── why this cannot reuse `AppShell` ──
 *
 * `AppShell` is the TENANT chrome: its sidebar, bottom bar and switcher all
 * resolve against `useNavSections()`, which reads tenant context. This area has
 * to work for a user with **zero farms** — the phase requires it explicitly —
 * and such a user has no tenant to resolve anything against. So the account
 * area gets its own, deliberately smaller shell, and nothing in this subtree
 * touches tenant context.
 *
 * ── what was wrong before ──
 *
 * `/account/profile` and `/account/security` existed as two unrelated
 * full-screen pages, each with its own centred card and background effects, and
 * with no way to get from one to the other. Measured: the user menu linked only
 * `/account/security`, so **`/account/profile` was reachable by typing the URL
 * and no other way**, and bare `/account` 404'd. A user with no farms could
 * reach neither: `/no-tenant` offered sign-out and nothing else.
 *
 * So this is a shell in the ordinary sense — one header, one nav, one place the
 * pages render into — rather than new chrome for its own sake.
 *
 * ── the back link ──
 *
 * `/tenants` rather than a farm URL, because it is the one destination that is
 * correct for every reader: it routes 0 memberships to `/no-tenant`, 1 straight
 * into that farm, and more than 1 to the picker. A link to a tenant dashboard
 * would 404 for exactly the users this shell exists to serve.
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
    // Gated once, here. The pages keep their own checks as defence in depth —
    // a layout is not a security boundary in the App Router, since a page can
    // be requested directly.
    const session = await auth();
    if (!session?.user) redirect('/login?next=/account');

    const t = await getTranslations('account.nav');

    return (
        <div className="min-h-screen bg-bg-page">
            <header className="border-b border-border-subtle bg-bg-default">
                <div className="mx-auto w-full max-w-3xl px-4 py-3">
                    <Link
                        href="/tenants"
                        data-testid="account-back"
                        className="inline-flex min-h-[44px] items-center gap-1 text-sm text-content-muted hover:text-content-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-md"
                    >
                        <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t('back')}</span>
                    </Link>

                    <div className="mt-1 mb-3">
                        <Heading level={1}>{t('title')}</Heading>
                        {session.user.email && (
                            <p className="mt-0.5 text-sm text-content-muted" data-testid="account-identity">
                                {session.user.email}
                            </p>
                        )}
                    </div>

                    <AccountNav />
                </div>
            </header>

            <main className="mx-auto w-full max-w-3xl px-4 py-6">{children}</main>
        </div>
    );
}
