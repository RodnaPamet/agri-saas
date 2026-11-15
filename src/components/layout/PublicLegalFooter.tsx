import { getTranslations } from 'next-intl/server';

/**
 * The legal footer for surfaces a signed-OUT visitor can reach (#3070).
 *
 * ## Why it exists: Google's consent-screen review
 *
 * Verification for a sensitive scope requires the app's HOMEPAGE, on the
 * verified domain, to link the privacy policy. Measured 2026-11-15: neither
 * `/` nor `/login` linked `/privacy` or `/terms` at all, so the requirement
 * was unmet and would have failed review.
 *
 * ## A server component with plain anchors, deliberately
 *
 * No `'use client'`, no handlers, no state. `/f/[handle]` is under a payload
 * budget that fails when a provider-only chunk reaches it
 * (`check-public-chunk-payload.mjs`), and the way to add a footer to a public
 * page without arguing with that gate is to ship no JavaScript at all.
 *
 * ## It reuses the canonical titles rather than inventing link labels
 *
 * `privacy.title` and `terms.title` are what those pages are already called.
 * `docs/nav-vocabulary.md` governs the nouns people navigate by, and a second
 * spelling of a surface's name is the defect that file exists to prevent — the
 * exchange was «Борса» in three places and «Пазар» in a fourth, every locale
 * self-consistent and every guard green.
 */
export async function PublicLegalFooter() {
    const privacy = await getTranslations('privacy');
    const terms = await getTranslations('terms');
    return (
        <footer className="mt-section border-t border-border-subtle pt-default text-sm text-content-muted">
            <nav className="flex flex-wrap gap-default">
                <a className="underline hover:text-content-default" href="/privacy">
                    {privacy('title')}
                </a>
                <a className="underline hover:text-content-default" href="/terms">
                    {terms('title')}
                </a>
            </nav>
        </footer>
    );
}
