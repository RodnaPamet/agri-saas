/**
 * Native sign-in — the four routes a phone actually walks.
 *
 * `/auth/me` was the only auth route in the spec, which described how to READ an
 * identity and nothing about how to obtain one. These four are the handoff, and
 * they were absent while a native client was being built against them.
 *
 * ── the shape of the flow, because no single route explains it ──
 *
 *   1. GET  /api/auth/native/start     app opens this in the SYSTEM browser
 *                                      -> 302 to the provider via NextAuth
 *   2.                                 (provider + NextAuth set a session cookie)
 *   3. GET  /api/auth/native/complete  -> 303 to the app's URI carrying the CODE
 *   4. POST /api/auth/native/exchange  code + verifier -> token pair
 *
 * Only step 4 is performed by the app itself; 1 and 3 are navigations inside
 * `ASWebAuthenticationSession`. `/adopt` is not part of this sequence — it
 * converts a bearer the app already holds into a WEBVIEW cookie session,
 * because a WKWebView authenticates server-rendered pages by cookie and cannot
 * attach an `Authorization` header to a top-level navigation.
 *
 * ── why the success is a REDIRECT and not a body ──
 *
 * Three of these four answer 3xx on success. A 200 with a JSON body would be a
 * lie about what the browser does with them, so `op()`'s success status was
 * widened to admit 3xx rather than documenting a response that does not exist.
 *
 * ── the PKCE challenge travels in a COOKIE, not in `state` ──
 *
 * Deliberate, and worth knowing because it constrains what a client may assume:
 * `state` round-trips through the provider and lands in browser history, while
 * the handoff cookie never leaves this origin. So a client cannot inspect or
 * carry the challenge itself between steps 1 and 3 — the server does.
 *
 * ── every failure on `/exchange` is the SAME shape, on purpose ──
 *
 * `{ "error": "invalid_grant" }` with 400 for an unknown code, an expired one,
 * and a PKCE mismatch alike. Distinguishing them is an oracle: telling an
 * interceptor which check defeated them is free help. A client therefore cannot
 * and should not branch on the reason — the only correct response is to restart
 * the flow at step 1.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

/** Unauthenticated by construction — the code and verifier ARE the credential. */
const NO_AUTH: Array<Record<string, string[]>> = [];

export function registerAuthNativePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/auth/native/start',
        operationId: 'startNativeSignIn',
        summary: 'Begin native sign-in in the system browser',
        description:
            'Opened by the app in an `ASWebAuthenticationSession`, NOT fetched. Stashes the PKCE challenge and the app’s delivery URI in a short-lived HttpOnly cookie and hands off to the existing NextAuth provider flow — nothing about provider sign-in is reimplemented. ' +
            '\n\n`redirect_uri` is checked against an allowlist; an unlisted one is a 400 `redirect_uri_not_allowed` rather than a redirect, which is what stops this being an open redirect. ' +
            '\n\nThe challenge lives in the cookie rather than in the OAuth `state` because `state` round-trips through the provider and lands in browser history.',
        tags: ['Auth'],
        security: NO_AUTH,
        query: z.object({
            redirect_uri: z
                .string()
                .openapi({ description: 'Where the CODE should be delivered. Allowlisted.' }),
            code_challenge: z.string().openapi({ description: 'PKCE challenge (S256).' }),
            code_challenge_method: z
                .string()
                .optional()
                .openapi({ description: 'S256. Anything else is a 400.' }),
            provider: z
                .string()
                .optional()
                .openapi({ description: 'Defaults to google. An unknown one is a 400.' }),
        }),
        success: {
            status: 302,
            description:
                'Redirect to the provider via NextAuth. Follow it in the browser session; there is no body.',
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/native/complete',
        operationId: 'completeNativeSignIn',
        summary: 'Mint the code and hand it to the app',
        description:
            'Reached by the SYSTEM browser after the provider flow has set a session cookie. Reads the handoff cookie, mints a short-lived PKCE-bound code against the session that now exists, and redirects to the app’s URI carrying the CODE AND NOTHING ELSE — no token, no identity. ' +
            '\n\nThe code is single-use and short-lived; it is spent at `/exchange`. ' +
            '\n\n**401 `not_authenticated`** means the browser reached here without a session — the provider step did not complete, and the client must restart at `/start`.',
        tags: ['Auth'],
        security: NO_AUTH,
        success: {
            status: 303,
            description:
                'Redirect to the app’s registered URI with the single-use code. No body.',
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/native/exchange',
        operationId: 'exchangeNativeAuthCode',
        summary: 'Exchange the code and PKCE verifier for a token pair',
        description:
            'The only step the app performs itself, and the only one with a JSON body. Unauthenticated by construction: the code plus the verifier ARE the credential. Rate-limited at the pre-auth tier. ' +
            '\n\nThe body accepts EITHER `code_verifier` or `codeVerifier` — both spellings are read, so a client need not guess. ' +
            '\n\nThe issued credential is a child of the SAME session the browser sign-in created, so every existing revocation lever reaches it with no separate bookkeeping. ' +
            '\n\n**Every failure is `400 { "error": "invalid_grant" }`** — unknown code, expired code and PKCE mismatch are indistinguishable ON PURPOSE. Do not branch on the reason; restart the flow at `/start`.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z
            .object({
                code: z.string().openapi({ description: 'The single-use code from /complete.' }),
                code_verifier: z
                    .string()
                    .optional()
                    .openapi({ description: 'The PKCE verifier. `codeVerifier` is also accepted.' }),
                codeVerifier: z
                    .string()
                    .optional()
                    .openapi({ description: 'camelCase alias of `code_verifier`.' }),
            })
            .openapi('NativeExchangeRequest', {
                description:
                    'One of `code_verifier` / `codeVerifier` is REQUIRED — the schema cannot express "exactly one of" without rejecting the other spelling, so both are optional here and the handler requires one. Sending neither is 400 invalid_grant.',
            }),
        success: {
            status: 200,
            description: 'The token pair.',
            schema: z
                .object({
                    accessToken: z.string(),
                    refreshToken: z.string(),
                    tokenType: z.literal('Bearer'),
                    /** Access-token lifetime in SECONDS (a duration, not a date). */
                    expiresIn: z.number(),
                    /** Refresh-token expiry as an ISO instant (a date, not a duration). */
                    refreshExpiresAt: z.string().datetime(),
                })
                .openapi('NativeTokenPair', {
                    description:
                        'expiresIn is a DURATION in seconds for the access token; refreshExpiresAt is an ISO INSTANT for the refresh token. The two are deliberately different kinds — do not treat expiresIn as a timestamp.',
                }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/native/adopt',
        operationId: 'adoptNativeSessionIntoWebview',
        summary: 'Turn a native bearer into a webview cookie session',
        description:
            'NOT part of the sign-in sequence. A Capacitor shell renders server pages in a WKWebView, and those are authenticated by COOKIE — `getServerSession()` reads the session store and never consults the header. A WKWebView cannot attach an `Authorization` header to a top-level navigation, and the system-browser flow writes its cookies into Safari’s jar rather than the app’s. So after a flawless native sign-in the bearer is valid and the webview is still logged out; this closes that gap. ' +
            '\n\nCall it with the bearer in the `Authorization` header, then follow the redirect: the response sets the session cookie and sends the shell on to `next`. ' +
            '\n\n`next` is sanitised to a path within this origin — an open redirect here would be reached with a VALID credential, which is exactly when one is worth most to an attacker. ' +
            '\n\n**401 `invalid_bearer`** for an absent, malformed or revoked token.',
        tags: ['Auth'],
        query: z.object({
            next: z
                .string()
                .optional()
                .openapi({ description: 'Same-origin path to land on. Sanitised server-side.' }),
        }),
        success: {
            status: 303,
            description: 'Sets the session cookie and redirects to `next`. No body.',
        },
    });
}
