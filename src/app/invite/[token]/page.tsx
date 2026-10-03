/**
 * /invite/[token] — Invite preview page.
 *
 * Server component. Calls previewInviteByToken, then renders:
 *   - If valid + signed in as matching email: direct "Accept" button.
 *   - If valid + not matching / not signed in: "Sign in to accept" link.
 *   - If expired/revoked/not-found: friendly error message.
 *
 * PR 4 will wire middleware redirects that land users here after sign-in
 * when their JWT carry an invite token. This page is the canonical place
 * for invite UX — do not inline invite acceptance anywhere else.
 */
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { previewInviteByToken } from '@/app-layer/usecases/tenant-invites';
import { formatDateLong } from '@/lib/format-date';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

interface InvitePageProps {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ error?: string }>;
}

export default async function InvitePage({ params, searchParams }: InvitePageProps) {
    const { token } = await params;
    const { error: errorParam } = await searchParams;
    const session = await auth();
    const sessionEmail = session?.user?.email ?? null;
    const t = await getTranslations('invite');

    const preview = await previewInviteByToken(token, sessionEmail);

    if (!preview) {
        return (
            <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
                <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8 text-center">
                    <div className="text-4xl mb-4">&#x26A0;&#xFE0F;</div>
                    <Heading level={1} className="mb-2">
                        {t('notAvailableTitle')}
                    </Heading>
                    <p className="text-content-muted">
                        {t('notAvailableBody')}
                    </p>
                </div>
            </main>
        );
    }

    const roleLabel = preview.role.charAt(0) + preview.role.slice(1).toLowerCase();
    const expiryLabel = formatDateLong(preview.expiresAt);

    // If the user is signed in as the invitee, show the direct accept button.
    // It links to the accept-redirect route, which redeems the invite and
    // 303-redirects to the new tenant dashboard — NEVER post to the bare
    // /api/invites/:token redeem endpoint from the UI: that returns JSON, so a
    // native navigation would dump raw JSON in the browser (the invite-JSON bug).
    const isReady = session && preview.matchesSession;
    const acceptUrl = `/api/invites/${token}/accept-redirect`;

    // start-signin sets the inflect_invite_token cookie then redirects to /login.
    // After OAuth the signIn callback reads the cookie and calls redeemInvite.
    const loginUrl = `/api/invites/${token}/start-signin`;

    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8">
                <Heading level={1} className="mb-2 text-center">
                    {t('invitedTitle')}
                </Heading>
                <p className="text-content-muted text-center mb-6">
                    {t.rich('invitedBody', {
                        tenantName: preview.tenantName,
                        roleLabel,
                        b: (chunks) => (
                            <span className="font-semibold text-content-default">
                                {chunks}
                            </span>
                        ),
                    })}
                </p>
                <p className="text-xs text-content-muted text-center mb-6">
                    {t('expires', { date: expiryLabel })}
                </p>

                {errorParam && (
                    <InlineNotice
                        variant="error"
                        icon={null}
                        className="mb-4 text-center"
                    >
                        {errorParam}
                    </InlineNotice>
                )}

                <a
                    href={isReady ? acceptUrl : loginUrl}
                    className="block w-full text-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                >
                    {isReady ? t('acceptInvitation') : t('signInToAccept')}
                </a>

                {session && !preview.matchesSession && (
                    <p className="mt-4 text-xs text-content-muted text-center">
                        {t.rich('mismatchBody', {
                            email: session.user?.email ?? '',
                            b: (chunks) => (
                                <span className="font-medium">{chunks}</span>
                            ),
                        })}
                    </p>
                )}
            </div>
        </main>
    );
}
