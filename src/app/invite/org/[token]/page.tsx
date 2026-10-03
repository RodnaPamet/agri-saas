/**
 * Epic D — /invite/org/[token]
 *
 * Org-invite acceptance page. Mirrors /invite/[token] for tenant
 * invites:
 *   - Server-rendered preview via previewOrgInviteByToken.
 *   - If valid + signed in as matching email: direct accept form.
 *   - If valid + not signed in: "Sign in to accept" link → start-signin.
 *   - If valid + email mismatch: prompt to switch accounts.
 *   - If invalid/expired/revoked: friendly single-shape error.
 *
 * Submission uses POST `/api/org/invite/<token>/accept-redirect` so
 * the browser follows the 303 to /org/<slug> on success or back to
 * this page with an `?error=` query on failure.
 */
import { getTranslations } from 'next-intl/server';

import { auth } from '@/auth';
import { previewOrgInviteByToken } from '@/app-layer/usecases/org-invites';
import { formatDateLong } from '@/lib/format-date';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

interface InvitePageProps {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ error?: string }>;
}

export default async function OrgInvitePage({ params, searchParams }: InvitePageProps) {
    const { token } = await params;
    const { error: errorParam } = await searchParams;
    const session = await auth();
    const sessionEmail = session?.user?.email ?? null;
    const t = await getTranslations('org.invite');

    const preview = await previewOrgInviteByToken(token, sessionEmail);

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

    const roleLabel =
        preview.role === 'ORG_ADMIN'
            ? t('roleAdmin')
            : preview.role === 'ORG_READER'
              ? t('roleReader')
              : preview.role;
    const expiryLabel = formatDateLong(preview.expiresAt);
    const isReady = session && preview.matchesSession;
    const loginUrl = `/api/org/invite/${token}/start-signin`;

    return (
        <main className="min-h-screen bg-bg-default flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-bg-default rounded-lg border border-border-subtle p-8">
                <Heading level={1} className="mb-2 text-center">
                    {t('invitedTitle')}
                </Heading>
                <p className="text-content-muted text-center mb-6">
                    {t.rich('invitedBody', {
                        orgName: preview.organizationName,
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
                        data-testid="org-invite-error"
                    >
                        {errorParam}
                    </InlineNotice>
                )}

                {isReady ? (
                    <OrgInviteAcceptForm token={token} />
                ) : (
                    <a
                        href={loginUrl}
                        className="block w-full text-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                        data-testid="org-invite-signin-cta"
                    >
                        {t('signInToAccept')}
                    </a>
                )}

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

async function OrgInviteAcceptForm({ token }: { token: string }) {
    const t = await getTranslations('org.invite');
    return (
        <form action={`/api/org/invite/${token}/accept-redirect`} method="POST">
            <button
                type="submit"
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                data-testid="org-invite-accept"
            >
                {t('acceptInvitation')}
            </button>
        </form>
    );
}
