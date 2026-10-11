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
import { op, rawErrorResponses, codedErrorResponses } from './helpers';

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

/**
 * The 202 from `signInWithApple` when the farm requires a second factor.
 *
 * A DISCRIMINATED shape, carrying `status` so it can never be decoded as a
 * token pair or the reverse. Two payloads differing only by which optional
 * keys are present is how a client ends up treating one as the other;
 * agrent-ios asked for the discriminant because their decoder picks a type
 * from the payload.
 *
 * Nothing here authenticates a single API call. The ticket is a server-stored,
 * hashed, single-use, PKCE-bound row carrying no claims — and
 * `exchangeNativeAuthCode` cannot redeem it, because that endpoint looks only
 * for session codes.
 */
const AppleMfaRequired = z
    .object({
        status: z.literal('mfa_required').openapi({
            description:
                'Always this value. Switch on it: a 202 is never a token pair and a 200 is never a ticket.',
        }),
        ticket: z.string().openapi({
            description:
                'Opaque, single-use, and useless without the `code_verifier` whose challenge you sent. Post it to `POST /api/auth/native/mfa` together with the code.',
        }),
        expiresIn: z.number().openapi({
            description:
                'SECONDS the ticket remains valid — a DURATION, not a date. Five minutes, which is time to open an authenticator and read a code. On expiry start sign-in again; a ticket cannot be refreshed.',
        }),
    })
    .openapi('AppleMfaRequired', {
        description:
            'Sign-in is accepted and INCOMPLETE: the identity token verified, and the farm requires a second factor the app must now collect.',
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
        extraResponses: {
            ...rawErrorResponses({
                400:
                    '`invalid_grant` — a BARE body. Covers a bad signature, the wrong audience, an expired token, a nonce mismatch and a replayed nonce, deliberately indistinguishable.',
                503:
                    '`apple_sign_in_disabled` — a BARE body. No Apple audience is configured for this flow, so the feature is dormant rather than broken.',
            }),
            202: {
                description:
                    'The farm requires a second factor and this request declared it can collect one (a `code_challenge` was sent). No token pair yet — redeem the ticket at `POST /api/auth/native/mfa`.',
                content: { 'application/json': { schema: AppleMfaRequired } },
            },
            ...codedErrorResponses({
                403:
                    'The farm requires a second factor this request cannot collect.\n\n' +
                    '`error.code` is `MFA_REQUIRED` whenever **no `code_challenge` was sent**. A client that did not opt in cannot show a code screen and does not know the enrolment code either, so it gets the one code it understands — the same opt-in rule as the 202 above. Use Google or Microsoft, or the web.\n\n' +
                    'It is `MFA_ENROLLMENT_REQUIRED` only for a client that DID send a `code_challenge` and whose account has no verified authenticator. There is no shared secret to check a code against, so the remedy is enrolment on the web rather than another provider — two codes because the two remedies differ, and gated on the opt-in so an older build never receives one it would render as a generic refusal.',
            }),
        },
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
                code_challenge: z.string().optional().openapi({
                    description:
                        'OPTIONAL, and sending it is how a client DECLARES it can handle a 202. Base64url SHA-256 of a fresh verifier, generated exactly as for `/native/start`; S256 only.' +
                        '\n\nOmit it and a farm requiring a second factor answers `403 MFA_REQUIRED` — which is what every build shipped before this field existed already handles. Send it and that case answers `202` with a ticket instead, so adding the field is opt-in per request rather than a change every client has to absorb at once.' +
                        '\n\nIt is also the ticket’s PKCE binding: keep the verifier in memory and send it to `POST /api/auth/native/mfa`. A ticket leaked through a log or a crash report is useless without it. `codeChallenge` is also accepted.',
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
        method: 'post',
        path: '/api/auth/native/mfa',
        extraResponses: codedErrorResponses({
            400:
                '`error.code` is `MFA_CODE_INVALID` when the ticket is fine and the CODE was wrong — `error.params.attemptsRemaining` is an integer, and at `0` the ticket is already burned by this same response, so say "too many wrong codes, sign in again" without another call to find out. ' +
                'It is `MFA_CODE_MALFORMED` when six digits were not supplied; that costs no attempt, because input that was never a guess should not spend one of five tries.',
            403:
                '`error.code` is `MFA_TICKET_INVALID`. ONE code for expired, consumed, unknown, wrong-purpose and PKCE-mismatched tickets, deliberately indistinguishable — the remedy is identical in every case (start sign-in again), and telling a caller which of five checks defeated it is free help to somebody probing. Do not branch on it beyond restarting.',
        }),
        operationId: 'completeNativeMfa',
        summary: 'Redeem a pending-MFA ticket with a TOTP code',
        description:
            'The second half of Apple sign-in at a farm that requires a second factor. `signInWithApple` returned `202` with a ticket; post it here with the six-digit code and the verifier whose challenge you sent. ' +
            '\n\n**Only reachable for Apple.** Google and Microsoft sign-in goes through the system browser, so their code is typed in the sign-in sheet and `completeNativeSignIn` simply withholds the auth code until it clears. There is no sheet in the Apple flow, which is why this endpoint exists at all — it is not a general-purpose MFA endpoint and the web does not use it. ' +
            '\n\n**The ticket is not a credential.** It is opaque, single-use, server-stored hashed, five-minute, and PKCE-bound; it carries no claims and authenticates nothing. `exchangeNativeAuthCode` cannot redeem it — that endpoint looks only for session codes, so a ticket is not found there rather than refused by a check. ' +
            '\n\n**Five wrong codes burn the ticket.** The cap is on the TICKET, not on an IP or an account, so it bounds exactly one sign-in attempt and cannot be sidestepped by reconnecting. It matches the web challenge\'s allowance, so the number of tries does not depend on which device somebody is holding. Expect `429` with `Retry-After` if the shared per-user limiter trips first. ' +
            '\n\n**On success you get the ordinary token pair**, with `termsPending` exactly as `signInWithApple` returns it — a first Apple sign-in can owe both a second factor and the terms.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z
            .object({
                ticket: z.string().openapi({
                    description: 'The `ticket` from the 202. Single-use.',
                }),
                code: z.string().openapi({
                    description:
                        'The six-digit TOTP code. Digits only — anything else answers `MFA_CODE_MALFORMED` and costs no attempt.',
                }),
                code_verifier: z.string().openapi({
                    description:
                        'The verifier whose SHA-256 you sent as `code_challenge` to `signInWithApple`. `codeVerifier` is also accepted. A mismatch answers `MFA_TICKET_INVALID` and does NOT consume the ticket — somebody else holding it must not be able to lock the real user out.',
                }),
            })
            .openapi('NativeMfaRequest'),
        success: {
            status: 200,
            description:
                'The factor was accepted. The ticket is consumed and this is the token pair.',
            schema: NativeTokenPair.extend({
                termsPending: z.boolean().openapi({
                    description:
                        'True when this account has no recorded terms acceptance. Every tenant and person route answers 403 until `POST /api/auth/accept-terms` succeeds.',
                }),
            }).openapi('NativeMfaResponse'),
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
