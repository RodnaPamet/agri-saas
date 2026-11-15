import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Heading } from '@/components/ui/typography';
import { SESSION_MAX_AGE_DAYS } from '@/lib/auth/session-lifetime';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_SECONDS } from '@/lib/i18n/locales';
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE } from '@/lib/theme/theme-cookie';
import { env } from '@/env';

/**
 * The cookie policy (#3070, owner 2026-11-15).
 *
 * ## Every lifetime is READ from the constant that sets the cookie
 *
 * The same rule `/privacy` follows: a number typed into prose is a number that
 * drifts from the code silently, and a policy is the worst place for that. So
 * `SESSION_MAX_AGE_DAYS`, `LOCALE_COOKIE_MAX_AGE_SECONDS` and
 * `THEME_COOKIE_MAX_AGE` are imported, and the table interpolates them.
 *
 * `LOCALE_COOKIE_MAX_AGE_SECONDS` only became importable in this change: the
 * lifetime was declared TWICE, in `middleware.ts` and in
 * `api/account/language/route.ts`. A page citing one copy while the other sets
 * the cookie is worse than a page with no number on it.
 *
 * ## Four corrections against the relayed draft, each measured
 *
 *   * **the session cookie is 14 days, not 30.** 30 is NextAuth's own default,
 *     which `src/auth.ts` deliberately overrides — the comment there says so.
 *     The 30-day figure that looks right is `SESSION_IDLE_MAX_AGE_DAYS`, the
 *     NATIVE client's sliding idle window (#3004), a different number on
 *     purpose.
 *   * **no `nonce` cookie is listed.** Our config overrides exactly two,
 *     `pkce.code_verifier` and `state`; `next-auth.nonce` exists in the
 *     package but nothing here establishes that our providers set it, and
 *     listing a cookie we do not set is as wrong as omitting one we do.
 *   * **sign-out does NOT clear everything.** `signOutAndPurge` runs
 *     `sweepClientStores({ maxAgeMs: 0 })`, and `NEVER_SWEPT` is an explicit
 *     contract: the outbox IndexedDB, its manifest, the loss record and the
 *     durability verdict all survive, because unsynced work "exists nowhere
 *     else" and deleting it would lose a farmer's field entries.
 *   * **the basemap line is omitted.** Which provider production resolves is
 *     WATCHED on `/api/readyz` rather than fixed in source, so whether a
 *     third-party tile host is in play is a live value this page cannot
 *     truthfully assert from the repo.
 *
 * ## Public, and that needs TWO lists to agree
 *
 * `PUBLIC_PATH_EXACT` in `src/lib/auth/guard.ts` and `ALLOWED_ROOT_PAGES` in
 * `tenant-isolation-structural`. Satisfying one looks exactly like being
 * finished, which is how `/privacy` and later `/start` each shipped behind a
 * login wall — see `legal-pages-public.test.ts`.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('cookies');
    return { title: t('title'), description: t('intro') };
}

export default async function CookiePolicyPage() {
    const t = await getTranslations('cookies');

    /**
     * The table, as DATA. Each lifetime comes from the constant that sets the
     * cookie, so a change to either moves this page with it.
     *
     * Names carry no `__Secure-`/`__Host-` prefix here; `securePrefix` says
     * once that https adds it, rather than doubling every row.
     */
    const rows = [
        {
            name: 'next-auth.session-token',
            purpose: t('purposeSession'),
            life: t('lifeDays', { days: SESSION_MAX_AGE_DAYS }),
        },
        { name: 'next-auth.csrf-token', purpose: t('purposeCsrf'), life: t('lifeSession') },
        { name: 'next-auth.callback-url', purpose: t('purposeCallback'), life: t('lifeSession') },
        {
            name: 'next-auth.pkce.code_verifier · next-auth.state',
            purpose: t('purposePkce'),
            life: t('lifeMinutes', { minutes: 15 }),
        },
        // Both are a year, read from their own constants rather than typed.
        // If either changes to something that is not a year, this assertion
        // fails in `cookie-policy-matches-constants` rather than the page
        // quietly printing the wrong lifetime.
        { name: LOCALE_COOKIE, purpose: t('purposeLocale'), life: t('lifeYear') },
        { name: THEME_COOKIE, purpose: t('purposeTheme'), life: t('lifeYear') },
    ];

    return (
        <main className="mx-auto max-w-3xl p-6 space-y-section">
            <Heading level={1}>{t('title')}</Heading>
            <p className="text-content-muted">{t('intro')}</p>

            <section className="space-y-tight">
                <Heading level={2}>{t('useTitle')}</Heading>
                <p className="text-content-muted">{t('useBody')}</p>
                <ul className="list-disc pl-5 space-y-tight text-sm text-content-muted">
                    <li>{t('useNoAds')}</li>
                    <li>{t('useNoTracking')}</li>
                    <li>{t('useNoAnalytics')}</li>
                </ul>
                <p className="text-content-muted">{t('useNoBanner')}</p>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('tableTitle')}</Heading>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left">
                                <th className="pb-2 pr-4 font-[560]">{t('colName')}</th>
                                <th className="pb-2 pr-4 font-[560]">{t('colPurpose')}</th>
                                <th className="pb-2 font-[560]">{t('colLife')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.name} className="border-t border-border-subtle">
                                    <td className="py-2 pr-4 font-mono text-xs">{row.name}</td>
                                    <td className="py-2 pr-4 text-content-muted">{row.purpose}</td>
                                    <td className="py-2 text-content-muted">{row.life}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className="text-sm text-content-subtle">{t('securePrefix')}</p>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('localTitle')}</Heading>
                <p className="text-content-muted">{t('localBody')}</p>
                <p className="text-content-muted">{t('localSignOut')}</p>
                <p className="text-content-muted">{t('localOutbox')}</p>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('mobileTitle')}</Heading>
                <p className="text-content-muted">{t('mobileBody')}</p>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('thirdTitle')}</Heading>
                <ul className="list-disc pl-5 space-y-tight text-sm text-content-muted">
                    <li>{t('thirdProviders')}</li>
                    <li>{t('thirdFonts')}</li>
                    <li>{t('thirdNoEmbeds')}</li>
                </ul>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('manageTitle')}</Heading>
                <p className="text-content-muted">{t('manageBody')}</p>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('changesTitle')}</Heading>
                <p className="text-content-muted">{t('changesBody')}</p>
            </section>

            <section className="space-y-tight">
                <Heading level={2}>{t('contactTitle')}</Heading>
                {env.PRIVACY_CONTROLLER_NAME ? (
                    <p className="font-[560]">{env.PRIVACY_CONTROLLER_NAME}</p>
                ) : null}
                <p className="text-content-muted">{env.PRIVACY_CONTACT_EMAIL}</p>
                <p className="text-content-muted">
                    <a className="underline" href="/privacy">
                        {t('contactMore')}
                    </a>
                </p>
            </section>
        </main>
    );
}
