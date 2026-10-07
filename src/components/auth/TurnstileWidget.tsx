'use client';

/**
 * Cloudflare Turnstile widget (P3.5c).
 *
 * Renders nothing at all when `sitekey` is null, which is the configuration
 * live today — bot screening is dormant until the operator supplies keys. The
 * null case is the DEFAULT path through this component, not an error path.
 *
 * ── why `next/script` and not an injected tag ──
 *
 * The first version of this file did `document.createElement('script')` and
 * `host.innerHTML = ''`. Both are flagged by
 * `tests/guards/csp-script-guardrails.test.ts`, and correctly: under
 * `script-src 'strict-dynamic'` a dynamically created script only loads if it
 * inherits trust, and the guardrail's own message names the remedy — use
 * `next/script`, which carries the request nonce. `replaceChildren()` does the
 * clearing job without an `innerHTML` assignment.
 *
 * Worth recording because both patterns LOOK like the obvious way to load a
 * third-party widget, and the version that trips the guardrail would have
 * worked in development and failed silently behind a strict CSP in production.
 *
 * What Turnstile still needs from the CSP is `frame-src
 * https://challenges.cloudflare.com` — the challenge renders in an iframe, and
 * without that host the widget is invisible rather than visibly broken, which
 * is the sort of failure nobody traces back to a header. See
 * `TURNSTILE_FRAME_SRC` in `lib/security/csp.ts`.
 *
 * ── the token is single-use, so resetting matters ──
 *
 * A Turnstile token may be redeemed once. After a failed submit the SAME token
 * is refused with `timeout-or-duplicate` however many times the person presses
 * the button, so the form has to reset the widget to get a fresh one. That is
 * what `resetSignal` is for: the parent increments it after any failed submit.
 * Without it a user who fails once can never succeed, and the error they see
 * ("verification failed") invites exactly the useless retry.
 */
import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
    render: (
        el: HTMLElement,
        opts: {
            sitekey: string;
            callback: (token: string) => void;
            'expired-callback'?: () => void;
            'error-callback'?: () => void;
            language?: string;
            theme?: 'auto' | 'light' | 'dark';
        },
    ) => string;
    remove: (widgetId: string) => void;
}

declare global {
    interface Window {
        turnstile?: TurnstileApi;
    }
}

export interface TurnstileWidgetProps {
    /** Public sitekey from `/api/auth/ui-config`. Null renders nothing. */
    sitekey: string | null;
    /** Called with a fresh token, and with null when it expires or errors. */
    onToken: (token: string | null) => void;
    /** Increment to force a fresh token after a failed submit. */
    resetSignal?: number;
    /** BCP-47 language for the widget's own copy. */
    language?: string;
}

export function TurnstileWidget({
    sitekey,
    onToken,
    resetSignal = 0,
    language = 'bg',
}: TurnstileWidgetProps) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [ready, setReady] = useState(false);

    // Held in a ref rather than a dependency: `onToken` changes identity on
    // every parent render, and depending on it would tear down and re-render
    // the widget mid-challenge.
    const onTokenRef = useRef(onToken);
    onTokenRef.current = onToken;

    useEffect(() => {
        if (!sitekey || !ready || !hostRef.current) return;
        const api = window.turnstile;
        if (!api) return;

        const host = hostRef.current;
        // `replaceChildren()` rather than `innerHTML = ''`: same effect, and
        // not an innerHTML assignment, which the CSP guardrail bans for good
        // reason even when the assigned value is a constant.
        host.replaceChildren();

        let widgetId: string | null = null;
        try {
            widgetId = api.render(host, {
                sitekey,
                language,
                theme: 'auto',
                callback: (token) => onTokenRef.current(token),
                // An expired or errored challenge must CLEAR the token the
                // parent holds. A stale one would be submitted and refused,
                // and the person could do nothing about it.
                'expired-callback': () => onTokenRef.current(null),
                'error-callback': () => onTokenRef.current(null),
            });
        } catch {
            // A failed render must leave the form usable. The SERVER decides
            // what an absent token means, and with a secret configured it
            // refuses — so failing quietly here cannot become a bypass.
            onTokenRef.current(null);
        }

        return () => {
            if (widgetId && window.turnstile) {
                try {
                    window.turnstile.remove(widgetId);
                } catch {
                    // `remove` throws if the widget is already gone (a fast
                    // unmount during load). Nothing to do, and it must not
                    // escape a cleanup function.
                }
            }
        };
    }, [sitekey, ready, language, resetSignal]);

    if (!sitekey) return null;

    return (
        <>
            <Script
                src={SCRIPT_SRC}
                strategy="afterInteractive"
                onReady={() => setReady(true)}
                // `onReady` rather than `onLoad`: it also fires when the script
                // was already loaded by a previous mount, which `onLoad` does
                // not. Without it, switching from register to login and back
                // leaves a permanently blank widget.
                onError={() => onTokenRef.current(null)}
            />
            {/* No text of our own: the widget supplies its own, localised by
                `language`. A label here would need a translation key for
                something Cloudflare already says. */}
            <div ref={hostRef} data-testid="turnstile-widget" className="mt-3" />
        </>
    );
}
