import { NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { TERMS_VERSION } from '@/lib/legal/terms';

/**
 * `GET /api/auth/terms` — the terms version a client must send back, and
 * where to read the document.
 *
 * ## Why it exists
 *
 * `POST /api/auth/accept-terms` requires `termsVersion` to equal the version
 * the server is serving, and **no route told a non-browser client what that
 * was** (reported by agrent-ios, P4.4). The web never needed one: it renders
 * `/terms` itself, so it has the constant in hand. A native client does not,
 * and without this it cannot satisfy the gate at all.
 *
 * That gap closes a trap rather than adding a convenience. A first Sign in
 * with Apple answers `termsPending: true`, and from then on every
 * `/api/t/**` and `/api/me/**` is a 403 until accept-terms succeeds — so a
 * client that cannot learn the version is permanently held with no way out.
 * Sending the user to the web is not a workaround for an Apple-only account
 * using Hide My Email.
 *
 * ## Why THIS path
 *
 * `/api/auth/terms` needs no change to either gate, which is the whole reason
 * it is not `/api/public/terms`:
 *
 *   - `isTermsAllowedPath` (`guard.ts`) returns true for any `/api/auth/`
 *     path, so a `termsPending` session reaches it — the one session that
 *     MUST be able to.
 *   - `/api/auth` is already in `PUBLIC_PATH_PREFIXES`, so an anonymous
 *     reader reaches it too, and sees the same document a signed-in one does.
 *
 * A route under `/api/public/` would have needed a `PUBLIC_PATH_EXACT` entry
 * AND an `isTermsAllowedPath` arm. Forgetting the second is precisely the
 * failure this endpoint exists to fix: a route a pending session cannot
 * reach, 403ing the call that would release it. Six routes in this repo have
 * shipped severed at that seam.
 *
 * It is NOT on `/api/auth/ui-config`, whose contract is "the flags the login
 * page needs to decide what to render". Terms acceptance happens AFTER
 * authentication, and a native client should not fetch a Turnstile sitekey it
 * will never render in order to learn a legal version.
 *
 * ## What it does and does not carry
 *
 * `version` is the `TERMS_VERSION` constant itself — the same import
 * accept-terms compares against, so the two cannot drift. The whole point of
 * that constant's docblock is that nothing restates the value.
 *
 * `url` is RELATIVE. An absolute URL would bake in an origin, and this
 * product is served on two hostnames; relative is correct for both and for an
 * in-app web view.
 *
 * No body text, and no `TERMS_ARE_LEGALLY_REVIEWED`. A client opens `url` to
 * show the document, so the page's own draft banner travels with it — a
 * second copy of that decision here would be a field to keep in step with no
 * reader, and a field in a response is a contract that cannot be withdrawn.
 */
export const dynamic = 'force-dynamic';

export const GET = withApiErrorHandling(async () => {
    return NextResponse.json({
        version: TERMS_VERSION,
        url: '/terms',
    });
});
