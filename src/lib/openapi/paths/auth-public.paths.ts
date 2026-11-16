/**
 * Public auth surfaces — what a client may read BEFORE it holds a credential.
 *
 * Separate from `auth-native.paths.ts` on purpose. That module documents the
 * handshake and the token lifecycle: every route in it is a step a client takes
 * to obtain or keep a credential. This one holds the routes a client reads
 * before it can offer a sign-in method at all, which is a different question
 * with a different audience — a login SCREEN, not a token exchange.
 *
 * It opens a seam rather than filling one. Around ten `/api/auth/*` routes are
 * still on `tests/guards/openapi-undocumented-baseline.json` — logout, register,
 * the password-reset pair, the verify-email pair, the SSO start/callback
 * quartet. Every one of them is a public auth surface and belongs here when it
 * is described, so the next entry to come off that baseline has an obvious home
 * and does not have to invent one or get filed under "native" for want of a
 * better place.
 */
import { z } from '@/lib/openapi/zod';
import {
    AuthRegisterStartSchema,
    ForgotPasswordSchema,
    ResetPasswordSchema,
} from '@/lib/schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op, rawErrorResponses } from './helpers';

/** Read before any credential exists — there is nothing to authenticate with yet. */
const NO_AUTH: Array<Record<string, string[]>> = [];

export function registerAuthPublicPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/auth/register/start',
        extraResponses: rawErrorResponses({
            400:
                '`invalid_request`, `turnstile_failed`, `disposable_email`, `terms_not_accepted` or `terms_version_stale` — a BARE body, not the envelope. `terms_version_stale` also carries `currentVersion`. These are coded refusals rather than schema rejections ON PURPOSE (#1393): a missing `acceptedTerms` is retryable, and a schema-level rejection would not be.',
        }),
        operationId: 'registerStart',
        summary: 'Begin registration: create an unverified account and email a 6-digit code',
        description:
            'Step 1 of registration v2. Creates an account whose email is NOT yet verified and emails a 6-digit code. It creates no farm — the email is proven first, and the farm is created afterwards by `POST /api/me/farms`.' +
            '\n\n**Every outcome returns the same 200 body.** A new address, an address part-way through signing up, and an address that already has a full account are indistinguishable in the response — deliberately, because the route it replaces answered `409 Email already registered` and was therefore a working account-enumeration oracle. The difference lands in the mailbox instead: a code for the first two cases, a "you already have an account" notice for the third. So a client must NOT infer anything about the address from a success, and must not tell the user "account created" — the honest message is "check your email".' +
            '\n\nThe password is hashed on every path, including the ones that discard it, so the request takes the same time whether or not the address is known. A client that times this endpoint learns nothing.' +
            '\n\nAn existing password is never overwritten by this call. Calling it again for an address that is already part-way through signing up reissues the CODE only.' +
            '\n\n400 means the REQUEST was wrong — a malformed body, a password failing policy, a password found in a breach corpus, or a refused Turnstile challenge (`turnstile_failed`, carrying Cloudflare error codes so a client can reset the widget; a token is single-use, so a blind retry always fails). Those say nothing about any address, which is why they are distinguishable from the uniform 200.' +
            '\n\nSince P3.1 two further 400s join that list, and for the same reason — both are statements about the REQUEST, not the address: `terms_not_accepted` when consent is absent or not literally `true`, and `terms_version_stale` when the client names a version other than the one being served, carrying `currentVersion` so the client can reload and show the new terms rather than a generic failure.',
        tags: ['Auth'],
        security: NO_AUTH,
        // ONE definition, not two (#1465). This used to be an inline
        // `z.object({…})` duplicating `AuthRegisterStartSchema`, and the two
        // had drifted into contradicting each other:
        //
        //   inline (published)   required: [acceptedTerms, email, name,
        //                                  password, termsVersion]
        //                        password: minLength 8
        //   schema  (runtime)    required: [email, name, password]
        //                        password: min(1)
        //
        // The runtime is right about both. A missing `acceptedTerms` answers
        // `terms_not_accepted` and a short password answers `too_short`; the
        // inline body told a client to expect `invalid_request` for either,
        // which is the distinction #1393 and the consent gate exist to make.
        // It also left `AuthRegisterStartRequest` an ORPHAN component that no
        // path referenced, so the document carried two contracts for one body
        // and published the wrong one.
        //
        // The field descriptions lived on the inline copy and are now on the
        // schema — ported rather than dropped, which is why this is not simply
        // a deletion. The CONSTRAINTS were deliberately not ported: the
        // schema's looser bounds are load-bearing, as its docblock explains.
        body: AuthRegisterStartSchema,
        success: {
            status: 200,
            description:
                'Always this, for every address. Means "we have done whatever was appropriate and sent an email" — NOT "an account was created".',
            schema: z
                .object({ ok: z.literal(true) })
                .openapi('RegisterStartResult', {
                    description:
                        'Intentionally carries no information about the address. Adding a field here that varied with account state would re-open the enumeration oracle this shape exists to close.',
                }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/register/verify',
        extraResponses: rawErrorResponses({
            400:
                '`invalid_request` — a BARE body, not the envelope.',
        }),
        operationId: 'registerVerify',
        summary: 'Finish email verification with the 6-digit code',
        description:
            'Step 2 of registration v2. On success the email is verified; the farm is still to be created via `POST /api/me/farms`, and a verified user with no farm is a normal state.' +
            '\n\n**All failures return one `400 {error: "invalid_code"}`.** Wrong, expired, and too-many-attempts are deliberately indistinguishable: "expired" can only be returned when a code exists for that address, so separating them would tell an attacker which addresses recently started signing up. Nothing is lost — the next action for the user is "request a new code" in every case.' +
            '\n\n**The code allows a small number of wrong guesses and is then destroyed**, which forces a fresh email rather than letting a guesser top up their budget. A client should surface "request a new code" rather than inviting repeated attempts.' +
            '\n\nVerifying twice is safe and does not move the recorded verification time.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z.object({
            email: z.string().min(1).max(320).openapi({ example: 'ivan@example.bg' }),
            code: z.string().openapi({
                description:
                    'Exactly 6 digits, as a STRING. It must stay a string end to end: `012345` is a valid code, and a JSON number silently makes it `12345`, which then fails for one user in ten with nothing to show why.',
                example: '048212',
            }),
        }),
        success: {
            status: 200,
            description: 'The email is verified. Proceed to create or join a farm.',
            schema: z
                .object({ ok: z.literal(true), verified: z.literal(true) })
                .openapi('RegisterVerifyResult'),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/forgot-password',
        operationId: 'requestPasswordReset',
        summary: 'Ask for a password-reset link',
        description:
            'Step 1 of the reset flow. Mints a single-use, 1-hour token for the address and '
            + 'emails the link.'
            + '\n\n**The answer is ALWAYS `{ "ok": true }`,** whatever happened — unknown '
            + 'address, an OAuth-only account with no password, a mailer failure. That '
            + 'uniformity IS the feature — variation in status, body or latency would make '
            + 'this an account-enumeration oracle on an unauthenticated route. So a client must '
            + 'NOT tell the user "we have sent you an email" as a statement of fact, and must '
            + 'never branch on this response to decide whether an address is registered — the '
            + 'honest copy is nearer "if that address has an account, a link is on its way".'
            + '\n\nRate-limited at 5/hour per IP (`EMAIL_DISPATCH_LIMIT`), the standard '
            + 'mitigation for an unauthenticated route that sends mail to an address the caller '
            + 'chose. A tripped limit is also absorbed into the same `ok: true`.',
        tags: ['Auth'],
        security: NO_AUTH,
        // The route's own schema, imported — not a second copy (#1555).
        body: ForgotPasswordSchema,
        success: {
            status: 200,
            description:
                'Always this, for any input. Carries no information about the address.',
            schema: z.object({ ok: z.boolean() }).openapi('ForgotPasswordResponse'),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/reset-password',
        operationId: 'resetPassword',
        summary: 'Spend a reset token and set a new password',
        description:
            'Step 2 of the reset flow. Validates the new password against the length policy AND '
            + 'screens it against known breaches (HIBP, k-anonymity), then consumes the one-time '
            + 'token and swaps the stored hash.'
            + '\n\n**Succeeding here revokes EVERY session for the account** — a `sessionVersion` '
            + 'bump plus `revokedAt` on every live `UserSession` row. A native client holding a '
            + 'token pair is signed out by this, including the one that performed the reset, so '
            + 'treat success as "now sign in again" rather than as being logged in.'
            + '\n\n**Token errors ARE surfaced,** unlike `forgot-password`’s deliberate silence: '
            + '"your link expired, request a new one" is genuinely useful and is not an '
            + 'enumeration vector, because a 256-bit token is unguessable. So this route '
            + 'distinguishes invalid from expired on purpose, and a client should render that '
            + 'difference.'
            + '\n\nA rejected password is a 400 the user can act on — too short, or found in a '
            + 'breach corpus. Do not retry it; show it.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: ResetPasswordSchema,
        extraResponses: rawErrorResponses({
            400:
                'The token was invalid or expired, or the new password failed the policy or the '
                + 'breach screen. The body says which; all four are for the user to read.',
        }),
        success: {
            status: 200,
            description: 'The password is changed and every session is revoked. Sign in again.',
            schema: z.object({ ok: z.boolean() }).openapi('ResetPasswordResponse'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/verify-email',
        operationId: 'verifyEmail',
        summary: 'Consume an email-verification link',
        description:
            'The target of the link in a verification email. Consumes a single-use 256-bit token '
            + '(24h TTL) and **302-redirects to the login page** with a status flag in the query '
            + 'string — the only channel by which the outcome is reported.'
            + '\n\nGET is correct here even though it mutates: the token itself is the '
            + 'authentication for the action, which is the standard email-click pattern. Replay '
            + 'is prevented at the database — the token row is deleted inside the same '
            + 'transaction that flips `User.emailVerified`.'
            + '\n\n**A client must follow the redirect and read the flag, not the status code.** '
            + 'There is no JSON body and no 200: success and failure are both 302, and treating '
            + 'the 302 itself as success reports a verified account for an expired link.',
        tags: ['Auth'],
        security: NO_AUTH,
        query: z.object({
            token: z.string().min(1).openapi({
                description: 'The raw token from the emailed link. Single-use.',
            }),
        }),
        success: {
            status: 302,
            description:
                'A redirect to the login page carrying the outcome as a query flag. No body.',
            schema: z.object({}).openapi('EmailVerificationRedirect', {
                description: 'Empty — the outcome travels in the Location header’s query string.',
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/auth/verify-email/resend',
        operationId: 'resendEmailVerification',
        summary: 'Re-issue a verification link',
        description:
            '**Uniform by design, like `forgot-password`:** the same 200 and the same body '
            + 'whether the address is registered, already verified, rate-limited, or the mailer '
            + 'errored. Any variation would leak whether an address has an account.'
            + '\n\nPer-identifier rate limiting still runs underneath — through the same bucket '
            + 'the login chokepoint uses — so this cannot be used to flood verification mail to a '
            + 'third party’s address. The limit being tripped is invisible in the response, '
            + 'which is the point.'
            + '\n\nThis route is deliberately NOT wrapped in the default mutation tier, and that '
            + 'matters for a reason beyond uniformity: slow mode narrows the default tier for '
            + 'unverified accounts, and an unverified account throttled on the very route that '
            + 'verifies it could not escape. `slow-mode-escape-is-not-throttled` pins that.',
        tags: ['Auth'],
        security: NO_AUTH,
        body: z
            .object({ email: z.string().email() })
            .openapi('ResendVerificationRequest'),
        success: {
            status: 200,
            description: 'Always this. Carries no information about the address.',
            schema: z.object({ ok: z.boolean() }).openapi('ResendVerificationResponse'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/ui-config',
        operationId: 'getAuthUiConfig',
        summary: 'Which sign-in methods the login screen should offer',
        description:
            'Read this on mount, before drawing a login screen. It answers which auth affordances to render — currently one flag. ' +
            '\n\nIt is a RUNTIME route rather than a build-time constant for a deployment reason worth knowing: a `NEXT_PUBLIC_*` value is inlined at `next build`, so flipping one would need a rebuild, an image push and a rollout. Reading `process.env` per request lets an operator change the flag with an env edit and a container recreate. A client must therefore treat the answer as CURRENT, not fixed for the life of its build, and re-read it rather than caching it across sessions. ' +
            '\n\nIt carries no secrets and needs no credential — it exposes only what the browser would otherwise have learned at build time.',
        tags: ['Auth'],
        security: NO_AUTH,
        success: {
            status: 200,
            description: 'The flags. Absent keys are not a contract — read each one explicitly.',
            schema: z
                .object({
                    credentialsFormHidden: z.boolean().openapi({
                        description:
                            'True means do NOT offer the email/password form. It is a UI instruction, not a capability statement: the Credentials provider stays registered server-side and the backend remains reachable for API clients and tests. A client that reads this as "credentials are disabled" will report the wrong reason when a sign-in fails.',
                    }),
                })
                .openapi('AuthUiConfig', {
                    description:
                        'Deliberately additive — flags are expected to be added here. Treat an unknown key as ignorable and a missing key as "use the built-in default", never as false.',
                }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/auth/terms',
        operationId: 'getTerms',
        summary: 'The terms version to send back, and where to read them',
        description:
            'Read this BEFORE `POST /api/auth/accept-terms`, which requires `termsVersion` to equal ' +
            'the version the server is serving. Until this route existed, nothing told a non-browser ' +
            'client what that value was — the web renders `/terms` itself so it has the constant in ' +
            'hand, and a native client did not (agrent-ios P4.4).' +
            '\n\n**It is the way out of a trap, not a convenience.** A first Sign in with Apple answers ' +
            '`termsPending: true`, after which every `/api/t/**` and `/api/me/**` is a 403 until ' +
            'acceptance is recorded. A client that cannot learn the version is held there permanently, ' +
            'and for an Apple-only account using Hide My Email there is no web fallback.' +
            '\n\n**Public and ungated**, like the document itself: an anonymous reader and a signed-in ' +
            'one see the same version. It is under `/api/auth/` so a `termsPending` session can reach ' +
            'it — that session is the one which MUST be able to.' +
            '\n\n**Do not cache across sessions.** The version changes when the terms change, which is ' +
            'exactly when a stale read is harmful: you would send a version the user did not see.' +
            '\n\nOn `400 terms_version_stale` from accept-terms, re-read this, show the document again ' +
            'and ask again. **Never retry with the `currentVersion` the error carries** — that files ' +
            'consent against a version the user never read, which is worse than the error, because the ' +
            'stored row is the only legal artifact the product keeps.',
        tags: ['Auth'],
        security: NO_AUTH,
        success: {
            status: 200,
            description: 'The current terms version and the page to read.',
            schema: z
                .object({
                    version: z.string().openapi({
                        description:
                            'Send this back verbatim as `termsVersion`. It is a DATE plus a `-draft` suffix while these terms are unreviewed, and the suffix is deliberate — a stored row reading `…-draft` can never be mistaken for acceptance of a reviewed document. Treat it as an opaque string: do not parse the date, and do not compare versions for ordering.',
                        example: '2026-10-07-draft',
                    }),
                    url: z.string().openapi({
                        description:
                            'The page to show. RELATIVE by design — this product is served on more than one hostname, so an absolute URL would bake in an origin that is right for only one of them. Resolve it against the origin you called.',
                        example: '/terms',
                    }),
                })
                .openapi('TermsInfo', {
                    description:
                        'Carries no body text: open `url` to show the document, so its own draft banner travels with it rather than being restated as a field here.',
                }),
        },
    });
}
