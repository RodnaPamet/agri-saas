import { PublicLegalFooter } from '@/components/layout/PublicLegalFooter';

/**
 * A server layout that exists for ONE reason: `/login`'s page is
 * `'use client'`, and the legal footer is a server component.
 *
 * Rendering `<PublicLegalFooter />` from inside `login/page.tsx` — which is
 * what #3070 first shipped — throws: the footer is `async` and calls
 * `getTranslations` from `next-intl/server`, so from a client module the
 * import resolves to the wrong side of the boundary and React is handed a
 * Promise to render as a child. The page then renders NOTHING, so
 * `#credentials-form` never appears and every E2E spec that signs in dies at
 * the login step 30 seconds later — four unrelated specs plus retries, which
 * is what a single systemic cause looks like from the outside.
 *
 * A layout is also simply where the footer belongs: it is chrome rather than
 * page content, and the page stays a pure client form.
 *
 * ## Not the two obvious alternatives
 *
 * Making the footer a client component would work here and is wrong twice
 * over: `/` is a server page that would then ship JS for three anchors, and
 * `useTranslations` needs a `NextIntlClientProvider` ancestor — which the
 * public `/f/[handle]` tree does not have, so a future mount there would 500
 * for a reason nothing in the component explains. Inlining three links in the
 * login page instead would be a second spelling of one footer, which is the
 * defect `PublicLegalFooter` was extracted to prevent.
 *
 * The footer sits BELOW the page's own `min-h-screen` centred card, so on
 * `/login` it is below the fold. That is deliberate: the card's vertical
 * centring is load-bearing for the `/login` CLS budget, and re-centring the
 * page to make room for a footer would spend a performance gate on chrome.
 */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-bg-page">
            {children}
            <div className="mx-auto w-full max-w-2xl px-4 pb-section">
                <PublicLegalFooter />
            </div>
        </div>
    );
}
