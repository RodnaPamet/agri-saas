'use client';

/**
 * Cloudflare Turnstile widget (P3.5c).
 *
 * Renders nothing at all when `sitekey` is null, which is the configuration
 * live today — bot screening is dormant until the operator supplies keys. The
 * null case is the DEFAULT path through this component, not an error path.
 *
 * ── why the script is injected rather than declared ──
 *
 * The CSP carries `script-src 'strict-dynamic'`, under which a script loaded
 * by an already-trusted script is itself trusted and host allowlists are
 * ignored. React's own bundle is nonce-bearing, so injecting the tag from an
 * effect is permitted and needs no `script-src` entry. What Turnstile DOES
 * need is `frame-src https://challenges.cloudflare.com`, because the challenge
 * renders in an iframe — see `TURNSTILE_FRAME_SRC` in `lib/security/csp.ts`.
 * Without it the widget is invisible rather than broken-looking, which is the
 * sort of failure nobody traces back to a header.
 *
 * ── the token is single-use, so resetting matters ──
 *
 * A Turnstile token may be redeemed once. After a failed submit the SAME token
 * will be refused with `timeout-or-duplicate` no matter how many times the
 * person presses the button, so the form has to reset the widget to obtain a
 * fresh one. That is what `resetSignal` is for: the parent increments it after
 * any failed submit, and the effect re-renders the widget. Without it a user
 * who fails once can never succeed, and the error they see ("verification
 * failed") invites exactly the useless retry.
 */
import { useEffect, useRef } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

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

/** Load `api.js` once per document, and resolve when `window.turnstile` exists. */
function loadTurnstileScript(): Promise<TurnstileApi | null> {
    if (typeof window === 'undefined') return Promise.resolve(null);
    if (window.turnstile) return Promise.resolve(window.turnstile);

    return new Promise((resolve) => {
        const existing = document.getElementById(SCRIPT_ID);
        if (existing) {
            // Another instance is already loading it. Waiting on the same
            // element's `load` is what keeps two widgets on one page from
            // injecting two copies of the script.
            existing.addEventListener('load', () => resolve(window.turnstile ?? null), {
                once: true,
            });
            existing.addEventListener('error', () => resolve(null), { once: true });
            return;
        }
        const el = document.createElement('script');
        el.id = SCRIPT_ID;
        el.src = SCRIPT_SRC;
        el.async = true;
        el.defer = true;
        // Resolving null on error rather than rejecting: a blocked or failed
        // script must leave the form usable. The server decides what an absent
        // token means, and with a secret configured it refuses — so failing
        // quietly here cannot become a bypass.
        el.addEventListener('load', () => resolve(window.turnstile ?? null), { once: true });
        el.addEventListener('error', () => resolve(null), { once: true });
        document.head.appendChild(el);
    });
}

export interface TurnstileWidgetProps {
    /** Public sitekey from `/api/auth/ui-config`. Null renders nothing. */
    sitekey: string | null;
    /** Called with a fresh token, and with null when it expires. */
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
    // Held in a ref rather than state: `onToken` changes identity on every
    // parent render, and depending on it would tear down and re-render the
    // widget mid-challenge.
    const onTokenRef = useRef(onToken);
    onTokenRef.current = onToken;

    useEffect(() => {
        if (!sitekey || !hostRef.current) return;

        let widgetId: string | null = null;
        let cancelled = false;
        const host = hostRef.current;

        loadTurnstileScript().then((api) => {
            if (cancelled || !api || !host) return;
            host.innerHTML = '';
            widgetId = api.render(host, {
                sitekey,
                language,
                theme: 'auto',
                callback: (token) => onTokenRef.current(token),
                // An expired or errored challenge must CLEAR the token the
                // parent is holding. Leaving a stale one there would send a
                // dead token and produce a refusal the person cannot act on.
                'expired-callback': () => onTokenRef.current(null),
                'error-callback': () => onTokenRef.current(null),
            });
        });

        return () => {
            cancelled = true;
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
    }, [sitekey, language, resetSignal]);

    if (!sitekey) return null;
    // No text of our own: the widget supplies its own, localised by
    // `language`. A label here would need a translation key for something
    // Cloudflare already says.
    return <div ref={hostRef} data-testid="turnstile-widget" className="mt-3" />;
}
