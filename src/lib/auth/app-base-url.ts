/**
 * Resolve the application's absolute origin for URLs that leave the request
 * context — email links and `NextResponse.redirect` targets.
 *
 * Why this exists. Three auth surfaces each wrote `env.APP_URL ?? ''`
 * independently. `APP_URL` is `.optional()` in `src/env.ts`, and it was unset
 * in production, so all three silently produced RELATIVE URLs. That broke two
 * things at once:
 *
 *   1. Verification and password-reset emails carried `/api/auth/...` hrefs.
 *      A mail client has no base document to resolve against, so the anchor
 *      renders as dead text — the mail looks plain-text and unclickable.
 *   2. `NextResponse.redirect()` REQUIRES an absolute URL. The verify-email
 *      route passed a relative one, threw, and returned 500 on every click.
 *
 * Together, under `AUTH_REQUIRE_EMAIL_VERIFICATION=1`, that meant a user could
 * register but never verify, and therefore never sign in — with no error
 * anywhere except a 500 the user saw as a broken page.
 *
 * The fix is to give every caller ONE resolver that cannot return a relative
 * base while any origin is configured. `NEXTAUTH_URL` is the fallback because
 * `src/env.ts` requires it (`z.string().url()`) off Vercel, so it is always
 * present in this deployment — the app cannot boot without knowing its origin.
 *
 * Request-scoped code should keep preferring `req.nextUrl.origin` (as the SSO
 * routes already do); this helper is for code that has no request in hand.
 */

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * Absolute origin with no trailing slash, so callers can safely append a
 * leading-slash path (`${getAppBaseUrl()}/login`).
 *
 * Returns `''` only when nothing at all is configured — a state the env schema
 * should prevent. That case is logged at ERROR rather than thrown, because the
 * callers are deliberately fail-safe (an email-send failure must not roll back
 * an already-committed token). A loud log is the difference between this
 * recurring silently and being caught.
 */
export function getAppBaseUrl(): string {
    const candidate = env.APP_URL ?? env.NEXTAUTH_URL;

    if (!candidate) {
        logger.error('app base URL is not configured', {
            component: 'auth',
            event: 'app_base_url_missing',
            detail:
                'Neither APP_URL nor NEXTAUTH_URL is set. Email links and ' +
                'redirect targets will be relative, which breaks mail clients ' +
                'and throws in NextResponse.redirect.',
        });
        return '';
    }

    return candidate.replace(/\/+$/, '');
}
