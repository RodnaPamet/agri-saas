/**
 * Native sign-in — the routes a phone actually walks, and the one that keeps it
 * signed in afterwards.
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
 *   5. POST /api/auth/token/refresh    spend the refresh token -> a NEW pair
 *
 * Step 5 is not part of the sign-in handshake; it is the whole reason the
 * handshake only has to happen once. It is documented here rather than beside
 * the public auth routes because it is meaningless without step 4 — `/exchange`
 * mints the first pair and `/refresh` is the only way to keep one alive.
 *
 * Only steps 4 and 5 are performed by the app itself; 1 and 3 are navigations inside
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
 *
 * `/api/auth/token/refresh` applies the same rule at 401, and adds a case the
 * exchange has not got: a REPLAYED refresh token. Replay is theft evidence, so
 * the server logs it at WARN — but the caller still gets the identical status
 * and body, because telling a thief their replay was noticed is the same free
 * help. `invalid_grant` from either route means one thing to a client: the
 * credential is gone, restart at step 1.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op, rawErrorResponses } from './helpers';

/** Unauthenticated by construction — the code and verifier ARE the credential. */
const NO_AUTH: Array<Record<string, string[]>> = [];

/**
 * The pair, hoisted because TWO routes answer it: `/native/exchange` mints the
 * first one and `/token/refresh` replaces it. Registering the component name
 * from both call sites would collide, and describing one wire shape in two
 * places is how the two descriptions drift apart.
 */
const NativeTokenPair = z
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
    });

export function registerAuthNativePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/auth/native/start',
        extraResponses: rawErrorResponses({
            400:
                '`invalid_request`, `unsupported_code_challenge_method`, `redirect_uri_not_allowed` or `unsupported_provider` — a BARE body, not the `ErrorResponse` envelope. The first two are RFC 6749 §5.2 / RFC 7636 codes; branch on the string.',
        }),
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
        extraResponses: rawErrorResponses({
            400:
                '`no_handoff`, `invalid_handoff` or `redirect_uri_not_allowed` — a BARE body, not the envelope.',
            401:
                '`not_authenticated` or `session_invalid` — a BARE body, not the envelope.',
            409:
                '`session_not_tracked` — a BARE body. The session exists but was never recorded, so it cannot be handed off; sign in again.',
        }),
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
        extraResponses: rawErrorResponses({
            400:
                '`invalid_grant` — a BARE body, as RFC 6749 §5.2 specifies for a token exchange.',
        }),
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
            schema: NativeTokenPair,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/native/apple',
        extraResponses: rawErrorResponses({
            400:
                '`invalid_grant` — a BARE body. Covers a bad signature, the wrong audience, an expired token, a nonce mismatch and a replayed nonce, deliberately indistinguishable.',
            503:
                '`apple_sign_in_disabled` — a BARE body. No Apple audience is configured for this flow, so the feature is dormant rather than broken.',
        }),
        operationId: 'signInWithApple',
        summary: 'Sign in with Apple — identity token to token pair',
        description:
            'The one native sign-in that does NOT go through the system browser. `ASAuthorizationController` hands the app an identity token directly, so there is no `/start`, no code and no PKCE verifier: this single call IS the sign-in. Unauthenticated by construction — the identity token is the credential — and rate-limited at the pre-auth tier. ' +
            '\n\n**The nonce is single-use.** Generate a fresh random `nonce` per attempt, pass its SHA-256 to Apple as the request nonce, and send the RAW value here. The server checks the hash matches the token AND claims the nonce exactly once, so a replayed token is refused even though its signature is still valid. Never reuse a nonce across attempts. ' +
            '\n\n**Every verification failure is `400 { "error": "invalid_grant" }`** — bad signature, wrong audience, expired token, mismatched nonce and replayed nonce are indistinguishable ON PURPOSE. Do not branch on the reason; start a fresh authorisation. ' +
            '\n\nTwo answers are deliberately distinguishable, because both are actionable and neither describes the token: `503 apple_sign_in_disabled` means the server has no Apple audience configured (an operator task, not a client bug), and `400 email_required` means Apple sent no email on what is a FIRST authorisation — request the email scope. ' +
            '\n\n**A first sign-in returns `termsPending: true`.** There is no browser here, so nothing showed the terms before the account existed. Present them and call `POST /api/auth/accept-terms` with the bearer; until then every tenant and person route answers 403. That route is reachable while pending, as is this one. ' +
            '\n\nApple sends `email` only on the FIRST authorisation — the account is keyed on Apple’s stable `sub`, so later sign-ins need no email and must not be treated as new users.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z
            .object({
                identityToken: z.string().openapi({
                    description:
                        'The JWT from `ASAuthorizationAppleIDCredential.identityToken`. `identity_token` is also accepted.',
                }),
                nonce: z.string().openapi({
                    description:
                        'The RAW nonce this attempt used — the server hashes it. `rawNonce` / `raw_nonce` are also accepted. Single-use.',
                }),
            })
            .openapi('AppleSignInRequest'),
        success: {
            status: 200,
            description:
                'The token pair, plus `termsPending` so the client knows whether to present the terms before doing anything else.',
            schema: NativeTokenPair.extend({
                termsPending: z.boolean().openapi({
                    description:
                        'True when this account has no recorded terms acceptance. Every tenant and person route answers 403 until `POST /api/auth/accept-terms` succeeds.',
                }),
            }).openapi('AppleSignInResponse'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/native/adopt',
        extraResponses: rawErrorResponses({
            401:
                '`invalid_bearer` — a BARE body, not the envelope.',
        }),
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

    op(registry, {
        method: 'post',
        path: '/api/auth/token/refresh',
        extraResponses: rawErrorResponses({
            401:
                '`invalid_grant` — a BARE body, as RFC 6749 §5.2 specifies. Covers an unknown, expired, rotated or revoked refresh token, deliberately indistinguishable.',
        }),
        operationId: 'refreshNativeToken',
        summary: 'Spend a refresh token for a new pair',
        description:
            'Step 5 of the flow above, and the reason the sign-in handshake only has to happen once. Send `{ "refreshToken": "…" }`; the answer is a COMPLETE new pair and the token sent is consumed. Rotation is unconditional — there is no "still valid, reuse it" reply — so a client must persist the new `refreshToken` before discarding the old one, or it has locked itself out. ' +
            '\n\nUnauthenticated by construction: the refresh token IS the credential, which puts this in the same abuse position as sign-in and is why it is rate-limited at the pre-auth tier rather than the default one. Do not send an `Authorization` header expecting it to matter — an expired access token is the normal reason to be here. ' +
            '\n\nThis route FAILS CLOSED, unlike per-request bearer verification: the underlying session is re-checked live and a revoked or expired one is refused. That is the moment a native client actually loses access after an admin revokes it. ' +
            '\n\nThe new access token is rebuilt from the session’s CURRENT claims, never from anything the client sent, so a changed role, a lost membership or a deleted tenant is reflected in the next access token. A refresh is not a way to keep stale authority alive, and a client must not assume its claims survive one unchanged. ' +
            '\n\n**Every failure is `401 { "error": "invalid_grant" }`** — malformed body, unknown token, revoked session and a REPLAYED token are indistinguishable on purpose (see the module docblock). Note this is 401 where `/exchange` uses 400 for the same shape. The only correct client response to either is to discard the pair and restart at `/api/auth/native/start`.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z
            .object({
                refreshToken: z
                    .string()
                    .min(1)
                    .openapi({
                        description:
                            'The refresh token from the previous pair. Consumed by this call.',
                    }),
            })
            .openapi('NativeRefreshRequest'),
        success: {
            status: 200,
            description:
                'A new pair. The refresh token sent has been consumed and must be replaced in storage.',
            schema: NativeTokenPair,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/native/revoke',
        extraResponses: rawErrorResponses({
            400:
                '`invalid_request` — a BARE body, not the envelope.',
        }),
        operationId: 'revokeNativeSession',
        summary: 'Sign this device out',
        description:
            'Revokes the session the presented refresh token hangs from, plus every token on it. Send `{ "refreshToken": "…" }`. ' +
            '\n\nSCOPE IS ONE DEVICE, NOT THE ACCOUNT. Other devices keep their own sessions and stay signed in. One caveat worth knowing rather than discovering: a native credential is a CHILD of the session the browser sign-in created, which in the ordinary flow was minted inside the system browser and is invisible to the user — but if that browser session was shared with an existing web login on the same machine, this ends that too. The blast radius is the session the credential descends from; that usually coincides with the device and is not guaranteed to. ' +
            '\n\nANSWERS 200 EVEN FOR A TOKEN IT HAS NEVER SEEN (RFC 7009). Distinguishing unknown from revoked would be an oracle for which tokens exist, and sign-out is retried on a flaky network, so a second attempt must not error for work that already succeeded. You therefore cannot learn whether anything was revoked — and do not need to: drop your tokens regardless. A malformed body is the one exception, because that is the caller’s own bug rather than a statement about any token. ' +
            '\n\nUnauthenticated by construction: the refresh token IS the credential, so this sits in the same abuse position as sign-in and is rate-limited at the pre-auth tier. ' +
            '\n\nThis exists because `/api/auth/logout` only clears a cookie and the three real revoke routes are tenant-scoped — a native sign-out has no single farm to address. Without it, clearing local state leaves the refresh token valid.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z
            .object({
                refreshToken: z
                    .string()
                    .min(1)
                    .openapi({ description: 'The refresh token for the session to end.' }),
            })
            .openapi('NativeRevokeRequest'),
        success: {
            status: 200,
            description:
                'Acknowledged. `{ "revoked": true }` regardless of whether a token matched — see the description.',
            schema: z.object({ revoked: z.literal(true) }).openapi('NativeRevokeResponse'),
        },
    });
}
