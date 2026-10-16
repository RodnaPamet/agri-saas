'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { sanitizeRedirectPath } from '@/lib/auth/safe-redirect';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { ShieldCheck, KeyRound, AlertTriangle } from 'lucide-react';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';

/**
 * MFA Challenge Page — shown when mfaPending is true.
 * User must enter a TOTP code to continue.
 *
 * After successful verification, redirects to the original target page
 * (or tenant home if no target is specified).
 */
export default function MfaChallengePage() {
    const t = useTranslations('mfa');
    const tc = useTranslations('mfa.challenge');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    // Default to /dashboard, not /, because `/t/<slug>/` has no
    // page.tsx (404) and post-MFA navigation would land on a broken
    // route if the URL didn't carry an explicit `next`.
    // SANITISED. This value is navigated to with `window.location.href` the
    // instant a correct code is accepted, and it arrived in the query string
    // — so unvalidated it was an open redirect at the single most convincing
    // moment to show a fake "session expired, sign in again" page: the person
    // has just proved to themselves they are mid-authentication.
    //
    // `sanitizeRedirectPath` already existed and was already used by
    // `buildLoginRedirect` and the consent page. This page simply never
    // called it. (It also had a `/\` gap, fixed in `safe-redirect` — a path
    // a browser normalises to `//`.) Found by agrent-ios.
    const rawNext = searchParams.get('next');
    // A REJECTED `next` falls back to the dashboard, not to `/`. The
    // sanitiser answers `/` for anything it refuses, and this page's own
    // comment says the dashboard is the intended default — landing a farm
    // member on the site root after a correct code is a worse answer than
    // the one it meant to give. Raised by agrent-ios.
    const sanitized = rawNext ? sanitizeRedirectPath(rawNext) : null;
    const next = sanitized && sanitized !== '/' ? sanitized : tenantHref('/dashboard');

    // Carried through the enrol link so a first-time enroller comes BACK here
    // to type their first code. Without it the setup page is a dead end: it
    // returns to its own status card, and in the phone's sign-in sheet the
    // only way onward is the back arrow, which nobody will guess.
    const enrolHref = `${tenantHref('/security/mfa')}?next=${encodeURIComponent(
        `${tenantHref('/auth/mfa')}${rawNext ? `?next=${encodeURIComponent(sanitizeRedirectPath(rawNext))}` : ''}`,
    )}`;

    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [attempts, setAttempts] = useState(0);

    // Check if user has MFA enrolled
    const [enrolled, setEnrolled] = useState<boolean | null>(null);
    const checkEnrollment = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll'));
            if (res.ok) {
                const data = await res.json();
                setEnrolled(data.isVerified);
            }
        } catch {
            // Fail silently
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- the setState lands after an await, in a later task, so this is not the synchronous render cascade the rule is about; the loader is an async useCallback whose deps cannot change while mounted, so it runs once
    useEffect(() => { checkEnrollment(); }, [checkEnrollment]);

    const handleVerify = async () => {
        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            setError(t('invalidCode'));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/challenge/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const data = await res.json();

            if (data.success) {
                // MFA challenge complete — redirect to original target
                // The JWT will be refreshed on next request, clearing mfaPending
                window.location.href = next;
            } else {
                setAttempts(a => a + 1);
                setCode('');
                setError(
                    attempts >= 4
                        ? tc('errTooMany')
                        : tc('errInvalid')
                );
            }
        } catch {
            setError(tc('errFailed'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && code.length === 6) {
            handleVerify();
        }
    };

    // If not enrolled, show enrollment redirect
    if (enrolled === false) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Card className="max-w-md w-full space-y-default text-center">
                    <div className="flex justify-center">
                        <div className="w-16 h-16 rounded-full bg-bg-warning flex items-center justify-center">
                            <AlertTriangle className="w-8 h-8 text-content-warning" />
                        </div>
                    </div>
                    <Heading level={1}>{tc('enrollRequiredTitle')}</Heading>
                    <p className="text-sm text-content-muted">
                        {tc('enrollRequiredDesc')}
                    </p>
                    <a
                        href={enrolHref}
                        className={buttonVariants({ variant: 'primary', className: 'w-full justify-center' })}
                        id="mfa-go-enroll-btn"
                    >
                        <KeyRound className="w-4 h-4" />
                        {t('setUpMfa')}
                    </a>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-[60vh] flex items-center justify-center">
            <Card className="max-w-md w-full space-y-default">
                <div className="flex justify-center">
                    <div className="w-16 h-16 rounded-full bg-[var(--brand-subtle)] flex items-center justify-center">
                        <ShieldCheck className="w-8 h-8 text-[var(--brand-default)]" />
                    </div>
                </div>

                <div className="text-center">
                    <Heading level={1}>{tc('verifyTitle')}</Heading>
                    <p className="text-sm text-content-muted mt-2">
                        {tc('verifyDesc')}
                    </p>
                </div>

                {error && (
                    <div className="p-3 rounded-lg border border-border-error bg-bg-error text-sm text-content-error text-center">
                        {error}
                    </div>
                )}

                <div className="flex flex-col items-center gap-default">
                    <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        onKeyDown={handleKeyDown}
                        className="input text-center text-2xl font-mono tracking-[0.4em] w-full sm:w-48 py-3"
                        id="mfa-challenge-input"
                        autoFocus
                        autoComplete="one-time-code"
                    />

                    <Button
                        variant="primary"
                        onClick={handleVerify}
                        disabled={submitting || code.length !== 6}
                        className="w-full justify-center"
                        id="mfa-challenge-submit"
                    >
                        {submitting ? t('verifying') : tc('continue')}
                    </Button>
                </div>

                <p className="text-xs text-content-subtle text-center">
                    {tc('cantAccess')}
                </p>
            </Card>
        </div>
    );
}
