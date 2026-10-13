'use client';

/**
 * Roadmap-14 PR-9 — `<EnvironmentBadge>` — non-prod environment chip.
 *
 * Mounts immediately after the brand mark in the top-bar left slot.
 * Visible ONLY outside production. The single visual that prevents
 * "I edited prod by mistake" — quiet enough to ignore, unmissable
 * once the user looks at the chrome.
 *
 * Three states:
 *
 *   PROD    no badge rendered (the chrome stays clean for the
 *           99% case)
 *   STAGING amber chip — "STAGING"
 *   DEV     red-tinted chip — "DEV"
 *
 * Detection is client-side via hostname matching. No env var is
 * required — the heuristic catches localhost + the canonical
 * `*-staging.` / `staging.` / `*.staging.*` patterns we use across
 * our deploy fleet.
 *
 * No brand tones used. The badge tones come from the status-colour
 * vocabulary (`bg-warning-emphasis`, `bg-error-emphasis`) so the
 * R10 StatusBadge brand-ban applies here too — using brand colours
 * here would make the chip look like an action affordance, not a
 * status signal.
 */

import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';

// ─── Types ─────────────────────────────────────────────────────────

type AppEnv = 'prod' | 'staging' | 'dev';

// ─── Recipes ───────────────────────────────────────────────────────

/**
 * Two visible tones — STAGING + DEV. PROD never renders so its
 * recipe is unused.
 *
 *   STAGING — `bg-warning-emphasis` (amber-700) — "watch out, this
 *             is the rehearsal stage". Loud enough to register at
 *             peripheral vision but not panic-inducing.
 *
 *   DEV     — `bg-error-emphasis` (red-700) — "this is the
 *             scratch pad". Same tone as the destructive primary
 *             button vocabulary; consistent with "do not assume
 *             your changes here are permanent".
 *
 * Both pills carry text-content-inverted (white) for legibility
 * on the dark fill, tabular-letterforms via uppercase tracking,
 * and a tight 4px vertical padding that keeps the chip inside the
 * brand-mark's 32px height envelope.
 */
const BADGE_BASE_CLASS =
    'inline-flex items-center rounded text-[10px] font-bold uppercase tracking-widest text-content-inverted px-1.5 py-0.5 leading-none';

const BADGE_STAGING_CLASS = `${BADGE_BASE_CLASS} bg-bg-warning-emphasis`;
const BADGE_DEV_CLASS = `${BADGE_BASE_CLASS} bg-bg-error-emphasis`;

// ─── Detection ─────────────────────────────────────────────────────

/**
 * Detect the current environment from the client hostname. Runs
 * once on mount. SSR-safe — returns `'prod'` on the server so the
 * badge isn't part of the SSR markup (would cause a hydration
 * flash for non-prod users; better to render the badge ONLY after
 * client-side detection settles).
 *
 * Detection rules — the patterns mirror our deploy infra:
 *
 *   • `localhost` / `127.0.0.1` / `*.local` → DEV
 *   • host starts with `staging.` or contains `.staging.` or
 *     contains `-staging.` → STAGING
 *   • host contains `dev.` or `-dev.` (Vercel preview deploys with
 *     dev branch names) → DEV
 *   • everything else → PROD
 *
 * If we ever ship multiple staging environments (`uat`, `qa`,
 * `preview`), extend this function. New environments map to one
 * of the existing tones (most likely STAGING amber) until they
 * warrant their own badge.
 */
/**
 * Classify a hostname. Exported so the rules are testable without a jsdom
 * navigation — the cases below are the whole contract of this badge, and
 * driving them through `window.location` would make each one a page load.
 */
export function classifyEnv(hostname: string): AppEnv {
    const host = hostname.toLowerCase();

    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
        return 'dev';
    }
    if (
        host.startsWith('staging.') ||
        host.includes('.staging.') ||
        host.includes('-staging.')
    ) {
        return 'staging';
    }
    if (host.includes('dev.') || host.includes('-dev.')) {
        return 'dev';
    }
    return 'prod';
}

/**
 * Read through `useSyncExternalStore`, not `useState` + an effect.
 *
 * `window.location.hostname` is client-only, so reading it during render would
 * mismatch the server's markup — the reason the effect existed, and still
 * true. What changes is the mechanism: the hook reads `getServerSnapshot`
 * while hydrating and `getSnapshot` after, instead of the component
 * triggering a render on itself with `setState` in an effect
 * (`react-hooks/set-state-in-effect`, #1471).
 *
 * `subscribe` is a no-op because a hostname cannot change without a
 * navigation, and a navigation is a new document. Said plainly so nobody
 * assumes reactivity that was never there.
 *
 * The server snapshot is `'prod'`, which renders nothing — the same answer
 * `useState<AppEnv>('prod')` gave, and the right one: the server cannot know
 * the host the browser used, and a badge is better absent than wrong.
 */
const subscribe = (): (() => void) => () => {};
const getServerSnapshot = (): AppEnv => 'prod';
const getSnapshot = (): AppEnv =>
    typeof window === 'undefined' ? 'prod' : classifyEnv(window.location.hostname);

function useAppEnv(): AppEnv {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ─── Component ─────────────────────────────────────────────────────

export function EnvironmentBadge() {
    const t = useTranslations('environmentBadge');
    const env = useAppEnv();

    if (env === 'prod') return null;

    if (env === 'staging') {
        return (
            <span
                className={BADGE_STAGING_CLASS}
                role="status"
                aria-label={t('stagingAria')}
                data-testid="top-chrome-env-badge"
                data-env="staging"
            >
                {t('staging')}
            </span>
        );
    }

    return (
        <span
            className={BADGE_DEV_CLASS}
            role="status"
            aria-label={t('devAria')}
            data-testid="top-chrome-env-badge"
            data-env="dev"
        >
            {t('dev')}
        </span>
    );
}
