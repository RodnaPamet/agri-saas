'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { TermsConsentCheckbox } from '@/components/auth/TermsConsentCheckbox';
import { signOutAndPurge } from '@/lib/auth/sign-out';
import { InlineNotice } from '@/components/ui/inline-notice';

export interface AcceptTermsFormProps {
    /**
     * The version this page is SERVING, passed down rather than imported here
     * so what the browser sends back as "the version I displayed" is the
     * version this render actually showed. The route refuses any other value.
     */
    termsVersion: string;
    /** Already sanitised by the page — never interpolate a raw query value. */
    next: string;
}

/**
 * Accept, or sign out.
 *
 * There is deliberately no third option. "Continue without accepting" is the
 * state the gate exists to end, and a dismissable notice would make the hold
 * decorative.
 *
 * ── the session has to be refreshed, not just the page ──
 *
 * `termsPending` is a JWT claim. The route writes the column, but the token in
 * this browser still says pending until it is re-minted — so a bare
 * `router.push` would bounce straight back here through the Edge gate, which
 * is a redirect loop that looks like the accept button not working.
 * `updateSession()` forces the `jwt` callback to run, and that callback
 * re-reads the column on every pass, so the claim clears. Only then navigate.
 */
export function AcceptTermsForm({ termsVersion, next }: AcceptTermsFormProps) {
    const t = useTranslations('acceptTerms');
    const router = useRouter();
    const [accepted, setAccepted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/accept-terms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acceptedTerms: true, termsVersion }),
            });
            if (!res.ok) {
                const data = (await res.json().catch(() => null)) as { error?: string } | null;
                // The one refusal worth naming: the terms changed while this
                // page was open, and the only useful thing to do is reload and
                // read the new ones. A generic message would send the person
                // round the same loop.
                setError(data?.error === 'terms_version_stale' ? t('stale') : t('failed'));
                setBusy(false);
                return;
            }

            // Re-mint the token BEFORE navigating — see the docblock.
            const { getSession } = await import('next-auth/react');
            await getSession();
            router.push(next);
            router.refresh();
        } catch {
            setError(t('failed'));
            setBusy(false);
        }
    }

    return (
        <div className="space-y-default">
            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            <TermsConsentCheckbox
                id="accept-terms"
                checked={accepted}
                onChange={setAccepted}
                disabled={busy}
            />

            <Button
                variant="primary"
                size="sm"
                className="w-full"
                disabled={busy || !accepted}
                onClick={submit}
            >
                {busy ? t('working') : t('submit')}
            </Button>

            {/* The way out. A gate with no exit is a trap, and somebody who
                does not want to agree is entitled to leave rather than be
                held between a page and a session they cannot drop. */}
            <Button
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={busy}
                onClick={() => signOutAndPurge({ callbackUrl: '/' })}
            >
                {t('decline')}
            </Button>
        </div>
    );
}
